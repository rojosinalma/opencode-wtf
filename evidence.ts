// Evidence for "why did the last turn stop": a metadata-only read of the OpenCode SQLite DB
// plus the matching journal window. Shared by the plugin (index.ts) and the bin/wtf-evidence CLI.
//
// Deliberately never includes user or assistant message TEXT: a content-filter stop must not
// re-trigger when the evidence is fed back to a model. Finish reasons, error objects, tool names
// and their error strings, timestamps and model ids only.
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

export type EvidenceOptions = {
  maxBytes: number
  journalLines: number
  errorChars: number
  // systemd user unit the server runs as; "" disables the journal section.
  journalUnit: string
  // Extra regular expressions (as source strings) that select journal lines in addition to the
  // session id and the built-in server-lifecycle patterns: typically the log prefixes of companion
  // plugins whose decisions can end a turn.
  journalPatterns: string[]
}

// Log prefixes of companion plugins (model swaps on rate limits, question-tool gating) whose
// journal lines explain a stop from outside the turn.
export const DEFAULT_JOURNAL_PATTERNS = ["\\[model-fallback\\]", "\\[question-gate\\]"]

export const EVIDENCE_DEFAULTS: EvidenceOptions = {
  maxBytes: 8192,
  journalLines: 40,
  errorChars: 300,
  journalUnit: "opencode",
  journalPatterns: DEFAULT_JOURNAL_PATTERNS,
}

type Row = { id: string; type: string; seq: number; time_created: number; data: string }
type ModelRef = { id?: string; providerID?: string; variant?: string }
type StructuredError = { type?: string; message?: string; status?: number }
type ToolPart = { type: "tool"; name?: string; tool?: string; id?: string; state?: { status?: string; error?: StructuredError | string } }
type Assistant = {
  time?: { created?: number; completed?: number }
  agent?: string
  model?: ModelRef
  content?: Array<{ type: string } & Partial<ToolPart>>
  finish?: string
  rawFinish?: string
  error?: StructuredError
  retry?: { attempt?: number; at?: number; error?: StructuredError }
}

export function dbPath(): string {
  if (process.env["OPENCODE_DB"]) return process.env["OPENCODE_DB"] as string
  const data = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share")
  return join(data, "opencode", "opencode.db")
}

function openReadonly(): Database {
  return new Database(dbPath(), { readonly: true })
}

export function newestSessionID(): string | undefined {
  const db = openReadonly()
  try {
    const row = db.query("SELECT id FROM session_v2 ORDER BY time_updated DESC LIMIT 1").get() as { id: string } | null
    return row?.id
  } finally {
    db.close()
  }
}

function iso(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "?"
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function modelString(model: ModelRef | undefined): string {
  if (!model?.id) return "?"
  return `${model.providerID ?? "?"}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

function errorString(error: StructuredError | string | undefined, max: number): string {
  if (!error) return ""
  if (typeof error === "string") return clip(error, max)
  const head = [error.type, error.status !== undefined ? `status ${error.status}` : undefined].filter(Boolean).join(" ")
  return clip(`${head}${error.message ? `: ${error.message}` : ""}`, max)
}

function parse<T>(row: Row): T | undefined {
  try {
    return JSON.parse(row.data) as T
  } catch {
    return undefined
  }
}

// Patterns that explain a stop from outside the turn: this plugin's own lines, server lifecycle,
// warnings and errors. Companion plugins' prefixes come from `journalPatterns`.
const BUILTIN_JOURNAL_PATTERNS = [
  /\[wtf\]/,
  /level=WARN/,
  /level=ERROR/,
  /\bStarted\b/,
  /\bStopping\b/,
  /\bStopped\b/,
  /\bDeactivated\b/,
  /Main process exited/,
  /Scheduled restart/,
]
const JOURNAL_NOISE = [/message="spawning process"/, /message="watcher subscribe"/]

// Compile the configured pattern sources; an invalid regular expression is skipped rather than
// taking the whole journal section down.
export function compileJournalPatterns(sources: string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source))
    } catch {
      // skipped
    }
  }
  return compiled
}

// Whether a journal line belongs in the evidence: not noise, and either carries the session id
// or matches one of the built-in or configured patterns.
export function journalLineMatches(line: string, sessionID: string, extra: RegExp[]): boolean {
  if (!line || JOURNAL_NOISE.some((rx) => rx.test(line))) return false
  if (line.includes(sessionID)) return true
  return BUILTIN_JOURNAL_PATTERNS.some((rx) => rx.test(line)) || extra.some((rx) => rx.test(line))
}

// Drop the "host opencode[pid]: timestamp=… level=" preamble (the short-iso stamp suffices) and
// the per-request identifiers that carry no explanation.
export function compactJournalLine(line: string): string {
  const compact = line
    .replace(/ \S+ [^\s\[]+\[\d+\]: (timestamp=\S+ )?/, " ")
    .replace(/ run=\S+/, "")
    .replace(/ http\.span=\S+/, "")
    .replace(/ role=server$/, "")
  return clip(compact, 300)
}

// Journal lines of the server's systemd user unit in the turn's window. Degrades to one
// explanatory line when journalctl is missing (non-systemd host) or the unit is unknown, so the
// rest of the evidence is still produced.
export function journalWindow(
  sinceMs: number,
  untilMs: number,
  sessionID: string,
  maxLines: number,
  unit: string = EVIDENCE_DEFAULTS.journalUnit,
  patterns: string[] = EVIDENCE_DEFAULTS.journalPatterns,
): string[] {
  if (!unit) return []
  const since = new Date(sinceMs - 5_000).toISOString()
  const until = new Date(untilMs + 5_000).toISOString()
  let out = ""
  try {
    if (!Bun.which("journalctl")) return ["(journalctl not found: no systemd journal on this host)"]
    const proc = Bun.spawnSync(
      ["journalctl", "--user", "-u", unit, "-o", "short-iso", "--no-pager", "--since", since, "--until", until],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (proc.exitCode !== 0) {
      const err = proc.stderr.toString().trim().split("\n")[0] ?? ""
      return [`(journalctl --user -u ${unit} failed: ${clip(err || `exit ${proc.exitCode}`, 200)})`]
    }
    out = proc.stdout.toString()
  } catch (error) {
    return [`(journalctl unavailable: ${error instanceof Error ? error.message : String(error)})`]
  }
  return selectJournalLines(out.split("\n"), sessionID, maxLines, patterns)
}

// Filter, compact and cap raw journal lines. Pure: the testable half of `journalWindow`.
export function selectJournalLines(raw: string[], sessionID: string, maxLines: number, patterns: string[]): string[] {
  const extra = compileJournalPatterns(patterns)
  const matched: string[] = []
  for (const line of raw) {
    if (!journalLineMatches(line, sessionID, extra)) continue
    matched.push(compactJournalLine(line))
  }
  if (matched.length > maxLines) {
    const dropped = matched.length - maxLines
    return [...matched.slice(0, maxLines), `(${dropped} more journal lines omitted)`]
  }
  return matched
}

export type Evidence = {
  text: string
  outcome: string
  turnStart?: number
  turnEnd?: number
  // Model of the last assistant step: the session's effective model when it has none set explicitly.
  lastModel?: { id: string; providerID: string; variant?: string }
}

export function gather(sessionID: string, options: Partial<EvidenceOptions> = {}): Evidence {
  const opts = { ...EVIDENCE_DEFAULTS, ...options }
  const db = openReadonly()
  let rows: Row[]
  let session: { title: string | null; directory: string; model: string | null; agent: string | null; parent_id: string | null } | null
  let pending: { type: string; delivery: string | null; time_created: number }[]
  try {
    session = db
      .query("SELECT title, directory, model, agent, parent_id FROM session_v2 WHERE id = ?")
      .get(sessionID) as typeof session
    rows = db
      .query("SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionID) as Row[]
    pending = db
      .query("SELECT type, delivery, time_created FROM session_pending WHERE session_id = ? ORDER BY time_created ASC")
      .all(sessionID) as typeof pending
  } finally {
    db.close()
  }
  if (!session) return { text: `No session ${sessionID} in ${dbPath()}.`, outcome: "unknown" }
  if (!rows.length) return { text: `Session ${sessionID} has no messages yet.`, outcome: "unknown" }

  // The last ended turn: previous `user` row … following `idle` row. If user/assistant rows
  // follow the last idle, that turn never ended (killed mid-step) and is the one to explain.
  const lastIdle = findLast(rows, (r) => r.type === "idle")
  const tail = lastIdle === -1 ? rows : rows.slice(lastIdle + 1)
  const unfinished = tail.some((r) => r.type === "user" || r.type === "assistant")
  let slice: Row[]
  let idle: Row | undefined
  if (unfinished) {
    const start = findLast(tail, (r) => r.type === "user")
    slice = start === -1 ? tail : tail.slice(start)
  } else if (lastIdle === -1) {
    return { text: `Session ${sessionID}: no finished turn and nothing in flight.`, outcome: "unknown" }
  } else {
    idle = rows[lastIdle]
    const before = rows.slice(0, lastIdle)
    const prevIdle = findLast(before, (r) => r.type === "idle")
    const start = findLast(before, (r) => r.type === "user")
    const from = Math.max(start, prevIdle + 1)
    slice = rows.slice(from === -1 ? 0 : from, lastIdle + 1)
  }

  const idleData = idle ? parse<{ outcome?: string; error?: StructuredError }>(idle) : undefined
  const outcome = unfinished ? "unfinished" : idleData?.outcome ?? "unknown"
  const turnStart = slice[0]?.time_created
  const turnEnd = idle?.time_created ?? slice[slice.length - 1]?.time_created ?? turnStart

  const lines: string[] = []
  lines.push(`session: ${sessionID}${session.parent_id ? ` (child of ${session.parent_id})` : ""}`)
  lines.push(`directory: ${session.directory}`)
  lines.push(`title: ${session.title ?? ""}`)
  lines.push(`turn: ${iso(turnStart)} → ${iso(turnEnd)} (${slice.length} rows, seq ${slice[0]?.seq}..${slice[slice.length - 1]?.seq})`)
  if (unfinished) {
    const ageS = Math.round((Date.now() - (turnEnd ?? 0)) / 1000)
    const hint = ageS < 180 ? "last row is recent, the turn may still be running" : "killed mid-step, likely a server restart/crash — see journal"
    lines.push(`ENDED: no — the turn has no \`idle\` row (last row ${ageS}s ago): ${hint}.`)
  } else {
    lines.push(`ENDED: outcome=${idleData?.outcome ?? "?"}${idleData?.error ? ` error=${errorString(idleData.error, opts.errorChars)}` : ""}`)
  }

  const assistants = slice.filter((r) => r.type === "assistant")
  const switches = slice.filter((r) => r.type === "model-switched" || r.type === "agent-switched")
  const others = slice.filter((r) => !["user", "assistant", "idle", "model-switched", "agent-switched"].includes(r.type))
  lines.push(`steps: ${assistants.length} assistant step(s)`)

  for (const [i, row] of assistants.entries()) {
    const a = parse<Assistant>(row)
    if (!a) continue
    const parts: string[] = [`  #${i + 1} ${iso(row.time_created)} model=${modelString(a.model)} agent=${a.agent ?? "?"}`]
    parts.push(`finish=${a.finish ?? "MISSING"}${a.rawFinish && a.rawFinish !== a.finish ? ` raw=${a.rawFinish}` : ""}`)
    if (!a.time?.completed) parts.push("not-completed")
    lines.push(parts.join(" "))
    if (a.error) lines.push(`     error: ${errorString(a.error, opts.errorChars)}`)
    if (a.retry) lines.push(`     retry: attempt ${a.retry.attempt ?? "?"} at ${iso(a.retry.at)} ${errorString(a.retry.error, opts.errorChars)}`)
    const tools = (a.content ?? []).filter((p): p is ToolPart => p.type === "tool")
    const kinds = { text: 0, reasoning: 0 }
    for (const p of a.content ?? []) if (p.type in kinds) kinds[p.type as keyof typeof kinds]++
    if (tools.length || kinds.text || kinds.reasoning) {
      const names = tools.map((t) => `${t.name ?? t.tool ?? "?"}:${t.state?.status ?? "?"}`)
      lines.push(`     parts: text=${kinds.text} reasoning=${kinds.reasoning} tools=[${names.join(", ")}]`)
    }
    for (const t of tools) {
      if (t.state?.status !== "error" && !t.state?.error) continue
      lines.push(`     tool error (${t.name ?? t.tool ?? "?"}): ${errorString(t.state?.error, opts.errorChars) || "(no message)"}`)
    }
  }

  if (switches.length) {
    lines.push("switches in turn:")
    for (const row of switches) {
      const d = parse<{ model?: ModelRef; previous?: ModelRef | string; agent?: string }>(row)
      if (row.type === "model-switched") {
        lines.push(`  ${iso(row.time_created)} model ${modelString(d?.previous as ModelRef)} → ${modelString(d?.model)}`)
      } else {
        lines.push(`  ${iso(row.time_created)} agent ${String(d?.previous ?? "?")} → ${d?.agent ?? "?"}`)
      }
    }
  }
  if (others.length) {
    lines.push(`other rows in turn: ${others.map((r) => r.type).join(", ")}`)
  }
  if (pending.length) {
    lines.push(`pending inbox: ${pending.map((p) => `${p.type}${p.delivery ? `/${p.delivery}` : ""}@${iso(p.time_created)}`).join(", ")}`)
  }
  lines.push(`session now: model=${modelString(parseJSON<ModelRef>(session.model))} agent=${session.agent ?? "?"}`)

  if (opts.journalUnit) {
    const journal = turnStart ? journalWindow(turnStart, turnEnd ?? turnStart, sessionID, opts.journalLines, opts.journalUnit, opts.journalPatterns) : []
    lines.push(`journal (${opts.journalUnit}.service, ${journal.length} matching lines):`)
    for (const line of journal) lines.push(`  ${line}`)
    if (!journal.length) lines.push("  (none)")
  }

  const lastStep = assistants.length ? parse<Assistant>(assistants[assistants.length - 1]) : undefined
  const lastModel = lastStep?.model?.id && lastStep.model.providerID ? (lastStep.model as Evidence["lastModel"]) : undefined
  return { text: capBytes(lines.join("\n"), opts.maxBytes), outcome, turnStart, turnEnd, lastModel }
}

function parseJSON<T>(text: string | null): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i
  return -1
}

// Cap the evidence to `max` bytes (UTF-8), ending a cut text with a visible marker.
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  const marker = "\n(evidence truncated)"
  let cut = text
  while (Buffer.byteLength(cut) + marker.length > max) cut = cut.slice(0, Math.floor(cut.length * 0.9))
  return cut + marker
}
