import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_JOURNAL_PATTERNS,
  EVIDENCE_DEFAULTS,
  capBytes,
  compactJournalLine,
  compileJournalPatterns,
  dbPath,
  gather,
  journalLineMatches,
  journalWindow,
  newestSessionID,
  selectJournalLines,
} from "../evidence"
import { resolveOptions, sessionArg } from "../index"

// --- pure helpers -----------------------------------------------------------------------------

describe("capBytes", () => {
  test("returns short text unchanged", () => {
    expect(capBytes("hello", 100)).toBe("hello")
  })

  test("cuts long text to the cap and appends the marker", () => {
    const text = "x".repeat(10_000)
    const out = capBytes(text, 1000)
    expect(out.endsWith("\n(evidence truncated)")).toBe(true)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1000)
    expect(out.length).toBeGreaterThan(500)
  })

  test("counts bytes, not characters", () => {
    const text = "é".repeat(600) // 1200 bytes
    const out = capBytes(text, 700)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(700)
    expect(out).toContain("(evidence truncated)")
  })
})

describe("compileJournalPatterns", () => {
  test("compiles the defaults", () => {
    const rx = compileJournalPatterns(DEFAULT_JOURNAL_PATTERNS)
    expect(rx).toHaveLength(2)
    expect(rx[0].test("x [model-fallback] swap: a -> b")).toBe(true)
    expect(rx[1].test("x [question-gate] nudged")).toBe(true)
  })

  test("skips invalid regular expressions", () => {
    expect(compileJournalPatterns(["[", "ok"])).toHaveLength(1)
  })
})

describe("journalLineMatches", () => {
  const extra = compileJournalPatterns(DEFAULT_JOURNAL_PATTERNS)
  const sid = "ses_abc123"

  test("empty and noise lines never match", () => {
    expect(journalLineMatches("", sid, extra)).toBe(false)
    expect(journalLineMatches(`x ${sid} message="spawning process"`, sid, extra)).toBe(false)
    expect(journalLineMatches('x level=WARN message="watcher subscribe"', sid, extra)).toBe(false)
  })

  test("the session id matches regardless of content", () => {
    expect(journalLineMatches(`2026-01-01T00:00:00+0000 host opencode[1]: level=INFO sessionID=${sid} done`, sid, extra)).toBe(true)
    expect(journalLineMatches("2026-01-01T00:00:00+0000 host opencode[1]: level=INFO sessionID=ses_other done", sid, extra)).toBe(false)
  })

  test("built-in lifecycle, warning and own-prefix patterns match", () => {
    for (const line of [
      "level=WARN something",
      "level=ERROR something",
      "systemd[1]: Started opencode.service",
      "systemd[1]: Stopping opencode.service",
      "systemd[1]: Stopped opencode.service",
      "systemd[1]: opencode.service: Deactivated successfully.",
      "systemd[1]: opencode.service: Main process exited, code=killed",
      "systemd[1]: opencode.service: Scheduled restart job",
      "opencode[1]: [wtf] restored model",
    ]) {
      expect(journalLineMatches(line, sid, [])).toBe(true)
    }
    expect(journalLineMatches("level=INFO plain request", sid, [])).toBe(false)
  })

  test("configured patterns match only when passed", () => {
    const line = "opencode[1]: [model-fallback] swap: a -> b"
    expect(journalLineMatches(line, sid, [])).toBe(false)
    expect(journalLineMatches(line, sid, extra)).toBe(true)
    expect(journalLineMatches("opencode[1]: [custom] hello", sid, compileJournalPatterns(["\\[custom\\]"]))).toBe(true)
  })
})

describe("compactJournalLine", () => {
  test("drops the process preamble and request identifiers", () => {
    const line =
      "2026-01-01T12:00:00+0000 host opencode[4242]: timestamp=2026-01-01T12:00:00.000Z level=WARN run=r1 http.span=s1 message=slow role=server"
    expect(compactJournalLine(line)).toBe("2026-01-01T12:00:00+0000 level=WARN message=slow")
  })

  test("clips to 300 characters", () => {
    const out = compactJournalLine(`2026-01-01T12:00:00+0000 host opencode[1]: ${"a".repeat(1000)}`)
    expect(out.length).toBe(301) // 300 + ellipsis
  })
})

describe("selectJournalLines", () => {
  const sid = "ses_abc123"
  const raw = [
    "",
    `2026-01-01T12:00:00+0000 host opencode[1]: level=INFO sessionID=${sid} prompt`,
    "2026-01-01T12:00:01+0000 host opencode[1]: level=INFO sessionID=ses_other prompt",
    "2026-01-01T12:00:02+0000 host opencode[1]: [model-fallback] swap: a -> b",
    "2026-01-01T12:00:03+0000 host systemd[1]: Stopping opencode.service",
    `2026-01-01T12:00:04+0000 host opencode[1]: level=INFO sessionID=${sid} message="spawning process"`,
  ]

  test("keeps session, pattern and lifecycle lines in order", () => {
    const out = selectJournalLines(raw, sid, 40, DEFAULT_JOURNAL_PATTERNS)
    expect(out).toEqual([
      `2026-01-01T12:00:00+0000 level=INFO sessionID=${sid} prompt`,
      "2026-01-01T12:00:02+0000 [model-fallback] swap: a -> b",
      "2026-01-01T12:00:03+0000 Stopping opencode.service",
    ])
  })

  test("without the companion patterns the plugin line is dropped", () => {
    expect(selectJournalLines(raw, sid, 40, [])).toHaveLength(2)
  })

  test("caps the number of lines and says how many were omitted", () => {
    const out = selectJournalLines(raw, sid, 1, DEFAULT_JOURNAL_PATTERNS)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe("(2 more journal lines omitted)")
  })
})

describe("journalWindow", () => {
  test("an empty unit disables the section", () => {
    expect(journalWindow(0, 1, "ses_x", 10, "")).toEqual([])
  })
})

// --- option resolution and argument parsing (index.ts) ---------------------------------------

describe("resolveOptions", () => {
  test("defaults match the documented values", () => {
    const o = resolveOptions()
    expect(o.maxEvidenceBytes).toBe(8192)
    expect(o.journalLines).toBe(40)
    expect(o.errorChars).toBe(300)
    expect(o.journalUnit).toBe("opencode")
    expect(o.journalPatterns).toEqual(DEFAULT_JOURNAL_PATTERNS)
    expect(o.restoreTimeoutMs).toBe(600_000)
    expect(o.smallAgent).toBe("title")
    expect(o.debug).toBe(false)
  })

  test("overrides are applied and journal_patterns keeps only strings", () => {
    const o = resolveOptions({ journal_unit: "", journal_patterns: ["\\[x\\]", 5, null], max_evidence_bytes: "100", debug: true })
    expect(o.journalUnit).toBe("")
    expect(o.journalPatterns).toEqual(["\\[x\\]"])
    expect(o.maxEvidenceBytes).toBe(100)
    expect(o.debug).toBe(true)
  })

  test("a non-array journal_patterns falls back to the defaults", () => {
    expect(resolveOptions({ journal_patterns: "nope" }).journalPatterns).toEqual(DEFAULT_JOURNAL_PATTERNS)
  })
})

describe("sessionArg", () => {
  test("extracts a session id anywhere in the text", () => {
    expect(sessionArg("/wtf ses_abc123DEF")).toBe("ses_abc123DEF")
    expect(sessionArg("please check ses_x1 now")).toBe("ses_x1")
    expect(sessionArg("/wtf")).toBeUndefined()
    expect(sessionArg(undefined)).toBeUndefined()
  })
})

// --- gather() against a fixture database -----------------------------------------------------

describe("gather", () => {
  let dir: string
  const quiet = { journalUnit: "" } // no journalctl in tests

  const sessions = {
    ok: "ses_ok000000",
    interrupted: "ses_int00000",
    failed: "ses_fail0000",
    unfinished: "ses_unfin000",
    empty: "ses_empty000",
  }

  type Msg = { type: string; data: Record<string, unknown> }
  const assistant = (extra: Record<string, unknown>) => ({
    type: "assistant",
    data: { time: { created: 1, completed: 2 }, agent: "build", model: { id: "m1", providerID: "p" }, finish: "stop", content: [{ type: "text" }], ...extra },
  })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wtf-test-"))
    process.env["OPENCODE_DB"] = join(dir, "opencode.db")
    const db = new Database(process.env["OPENCODE_DB"])
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, agent TEXT, parent_id TEXT, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
      CREATE TABLE session_pending (session_id TEXT, type TEXT, delivery TEXT, time_created INTEGER);
    `)
    const addSession = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)")
    const addMsg = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
    const addPending = db.prepare("INSERT INTO session_pending VALUES (?, ?, ?, ?)")
    let seq = 0
    const write = (id: string, msgs: Msg[], updated: number) => {
      addSession.run(id, `title ${id}`, "/work/demo", JSON.stringify({ id: "m1", providerID: "p" }), "build", null, updated)
      let t = 1_700_000_000_000
      for (const m of msgs) addMsg.run(`msg_${++seq}`, id, m.type, seq, (t += 1000), JSON.stringify(m.data))
    }

    // Two turns; only the second (succeeded) one must be reported.
    write(
      sessions.ok,
      [
        { type: "user", data: {} },
        assistant({ finish: "length" }),
        { type: "idle", data: { outcome: "failed" } },
        { type: "user", data: {} },
        assistant({}),
        { type: "idle", data: { outcome: "succeeded" } },
      ],
      1,
    )
    write(
      sessions.interrupted,
      [
        { type: "user", data: {} },
        assistant({ finish: "aborted", time: { created: 1 }, content: [{ type: "tool", name: "shell", state: { status: "error", error: "Step interrupted" } }] }),
        { type: "idle", data: { outcome: "interrupted", error: { type: "aborted", message: "Step interrupted" } } },
      ],
      2,
    )
    write(
      sessions.failed,
      [
        { type: "user", data: {} },
        assistant({ finish: "error", error: { type: "provider.rate-limit", status: 429, message: "Too many  requests\nfor model" }, retry: { attempt: 2, at: 5, error: { message: "429" } } }),
        { type: "model-switched", data: { previous: { id: "m1", providerID: "p" }, model: { id: "m2", providerID: "p" } } },
        { type: "idle", data: { outcome: "failed", error: { type: "provider.rate-limit", status: 429, message: "Too many requests" } } },
      ],
      3,
    )
    addPending.run(sessions.failed, "prompt", "steer", 1_700_000_009_000)
    write(
      sessions.unfinished,
      [
        { type: "user", data: {} },
        assistant({}),
        { type: "idle", data: { outcome: "succeeded" } },
        { type: "user", data: {} },
        assistant({ finish: undefined, time: { created: 1 } }),
      ],
      9, // newest
    )
    addSession.run(sessions.empty, null, "/work/demo", null, null, null, 0)
    db.close()
  })

  afterAll(() => {
    delete process.env["OPENCODE_DB"]
    rmSync(dir, { recursive: true, force: true })
  })

  test("dbPath honours OPENCODE_DB and newestSessionID picks the latest", () => {
    expect(dbPath()).toBe(process.env["OPENCODE_DB"])
    expect(newestSessionID()).toBe(sessions.unfinished)
  })

  test("a normal stop reports the last turn only", () => {
    const e = gather(sessions.ok, quiet)
    expect(e.outcome).toBe("succeeded")
    expect(e.text).toContain("ENDED: outcome=succeeded")
    expect(e.text).toContain("steps: 1 assistant step(s)")
    expect(e.text).toContain("finish=stop")
    expect(e.text).not.toContain("finish=length")
    expect(e.text).not.toContain("journal (")
    expect(e.lastModel).toEqual({ id: "m1", providerID: "p" })
  })

  test("an interrupt carries the idle error and the tool error", () => {
    const e = gather(sessions.interrupted, quiet)
    expect(e.outcome).toBe("interrupted")
    expect(e.text).toContain("ENDED: outcome=interrupted error=aborted: Step interrupted")
    expect(e.text).toContain("finish=aborted not-completed")
    expect(e.text).toContain("tool error (shell): Step interrupted")
  })

  test("a provider failure lists error, retry, switch and pending inbox", () => {
    const e = gather(sessions.failed, quiet)
    expect(e.outcome).toBe("failed")
    expect(e.text).toContain("error: provider.rate-limit status 429: Too many requests for model")
    expect(e.text).toContain("retry: attempt 2")
    expect(e.text).toContain("model p/m1 → p/m2")
    expect(e.text).toContain("pending inbox: prompt/steer@")
  })

  test("a turn without an idle row is reported as unfinished", () => {
    const e = gather(sessions.unfinished, quiet)
    expect(e.outcome).toBe("unfinished")
    expect(e.text).toContain("ENDED: no — the turn has no `idle` row")
    expect(e.text).toContain("finish=MISSING")
  })

  test("error_chars truncates error text", () => {
    const e = gather(sessions.failed, { ...quiet, errorChars: 20 })
    expect(e.text).toContain("error: provider.rate-limit …")
    expect(e.text).not.toContain("status 429")
  })

  test("max_evidence_bytes caps the text", () => {
    const e = gather(sessions.failed, { ...quiet, maxBytes: 200 })
    expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(200)
    expect(e.text).toEndWith("(evidence truncated)")
  })

  test("unknown and empty sessions degrade to a one-line message", () => {
    expect(gather("ses_missing", quiet)).toMatchObject({ outcome: "unknown", text: expect.stringContaining("No session ses_missing") })
    expect(gather(sessions.empty, quiet)).toMatchObject({ outcome: "unknown", text: expect.stringContaining("has no messages yet") })
  })

  test("the journal section header appears when a unit is set", () => {
    // journalctl is either absent (one explanatory line) or present (real lines); either way the header is there.
    const e = gather(sessions.ok, { journalUnit: "no-such-unit-wtf-test" })
    expect(e.text).toMatch(/journal \(no-such-unit-wtf-test\.service, \d+ matching lines\):/)
  })

  test("defaults are the documented ones", () => {
    expect(EVIDENCE_DEFAULTS).toEqual({ maxBytes: 8192, journalLines: 40, errorChars: 300, journalUnit: "opencode", journalPatterns: DEFAULT_JOURNAL_PATTERNS })
  })
})
