// Type-only import: the plugin directory may have no node_modules of its own, so nothing from
// @opencode/plugin is needed at runtime.
import type { Plugin } from "@opencode/plugin"
import { DEFAULT_JOURNAL_PATTERNS, gather } from "./evidence"

// `/wtf [ses_…]`: explains why the previous turn of the invoking session (or the given one)
// stopped. The evidence — finish reasons, provider errors, tool errors, model/agent switches,
// pending inbox items and the matching server journal window (`journal_unit`) — is gathered here from
// the SQLite DB (read-only) and journalctl, never from message text, and the explanation runs
// on the configured small model (`small_model`, which the server normalises to the `title`
// agent's model) so the outage that killed the previous turn cannot kill the explanation. The
// session's own model is restored when that turn ends.

export type Options = {
  maxEvidenceBytes: number
  journalLines: number
  errorChars: number
  journalUnit: string
  journalPatterns: string[]
  restoreTimeoutMs: number
  smallAgent: string
  debug: boolean
}

export function resolveOptions(raw: Readonly<Record<string, any>> = {}): Options {
  return {
    maxEvidenceBytes: Number(raw.max_evidence_bytes ?? 8192),
    journalLines: Number(raw.journal_lines ?? 40),
    errorChars: Number(raw.error_chars ?? 300),
    journalUnit: typeof raw.journal_unit === "string" ? raw.journal_unit : "opencode",
    journalPatterns: Array.isArray(raw.journal_patterns)
      ? raw.journal_patterns.filter((p: unknown): p is string => typeof p === "string")
      : DEFAULT_JOURNAL_PATTERNS,
    restoreTimeoutMs: Number(raw.restore_timeout_ms ?? 10 * 60 * 1000),
    smallAgent: String(raw.small_agent ?? "title"),
    debug: raw.debug === true,
  }
}

type ModelRef = { id: string; providerID: string; variant?: string }

const INSTRUCTION = [
  "Explain in at most 12 lines why the previous turn of this session stopped, using ONLY the evidence below.",
  "1. Category: provider / harness-plugin / permission / user-interrupt / server-restart / normal-stop / unknown.",
  "2. The concrete cause, quoting the error text from the evidence where there is one.",
  "3. What to do next (retry, wait, switch model, resume, nothing).",
  "Do not call tools. Do not quote or guess user or assistant message text; the evidence deliberately omits it.",
  "A `finish=stop` with outcome=succeeded is a normal stop: say so briefly. `aborted: Step interrupted` with",
  "outcome=interrupted is a user interrupt. A missing `idle` row with journal Started/Stopping lines is a server restart.",
].join(" ")

export function sessionArg(text: string | undefined): string | undefined {
  const match = /\bses_[A-Za-z0-9]+/.exec(text ?? "")
  return match?.[0]
}

export function modelKey(model: ModelRef | undefined): string {
  return model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "?"
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return !!a && !!b && a.providerID === b.providerID && a.id === b.id
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const END_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
])

const plugin: Plugin.Plugin = {
  id: "wtf",
  async setup(ctx) {
    const opts = resolveOptions(ctx.options)
    const log = (msg: string) => console.error(`[wtf] ${msg}`)
    const debug = (msg: string) => opts.debug && log(msg)

    // Sessions whose model we switched and must restore at the end of the explanation turn.
    // One-shot per session; a timer covers the case where the end event never arrives.
    const pending = new Map<string, { previous: ModelRef; timer: ReturnType<typeof setTimeout> }>()

    const restore = async (sessionID: string, why: string) => {
      const entry = pending.get(sessionID)
      if (!entry) return
      pending.delete(sessionID)
      clearTimeout(entry.timer)
      try {
        await ctx.session.switchModel({ sessionID, model: entry.previous })
        log(`restored model ${modelKey(entry.previous)} for ${sessionID} (${why})`)
      } catch (error) {
        log(`failed to restore model for ${sessionID}: ${errorMessage(error)}`)
      }
    }

    // `small_model` is normalised by the server into the title agent's model, so that agent is
    // the one place the merged configuration exposes it.
    const smallModel = async (): Promise<ModelRef | undefined> => {
      try {
        const agent = (await ctx.agent.get({ agentID: opts.smallAgent })) as any
        const model = (agent?.data?.model ?? agent?.model) as ModelRef | undefined
        return model?.id && model.providerID ? { id: model.id, providerID: model.providerID } : undefined
      } catch (error) {
        log(`could not resolve small model via agent "${opts.smallAgent}": ${errorMessage(error)}`)
        return undefined
      }
    }

    const defaultModel = async (): Promise<ModelRef | undefined> => {
      try {
        const selected = (await ctx.model.default()) as any
        const id = selected?.modelID ?? selected?.id
        return id && selected?.providerID ? { id, providerID: selected.providerID } : undefined
      } catch (error) {
        debug(`model.default unavailable: ${errorMessage(error)}`)
        return undefined
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "wtf",
        description: "Explain why the last turn stopped",
        async execute({ sessionID, prompt, delivery }) {
          const target = sessionArg(prompt.text) ?? sessionID
          const evidence = gather(target, {
            maxBytes: opts.maxEvidenceBytes,
            journalLines: opts.journalLines,
            errorChars: opts.errorChars,
            journalUnit: opts.journalUnit,
            journalPatterns: opts.journalPatterns,
          })

          // A session without an explicit model runs on its agent's default; restoring to the
          // model the last step actually used keeps it on the same model, now pinned.
          let current: ModelRef | undefined
          try {
            const info = (await ctx.session.get({ sessionID })) as any
            current = (info?.data?.model ?? info?.model) as ModelRef | undefined
          } catch (error) {
            log(`could not read session ${sessionID}: ${errorMessage(error)}`)
          }
          if (!current && target === sessionID) current = evidence.lastModel
          if (!current) current = await defaultModel()
          const small = await smallModel()
          let header: string
          if (!small) {
            header = "(no small_model configured; answering on the session's own model)"
            log(`session=${sessionID} target=${target} outcome=${evidence.outcome} model=${modelKey(current)} → small=none`)
          } else if (!current || sameModel(current, small)) {
            header = `(answering on ${modelKey(small)})`
            log(`session=${sessionID} target=${target} outcome=${evidence.outcome} model=${modelKey(current)} → small=${modelKey(small)} (no switch)`)
          } else {
            try {
              await ctx.session.switchModel({ sessionID, model: small })
              const timer = setTimeout(() => void restore(sessionID, "timeout"), opts.restoreTimeoutMs)
              pending.set(sessionID, { previous: current, timer })
              header = `(answering on ${modelKey(small)}; ${modelKey(current)} is restored afterwards)`
              log(`session=${sessionID} target=${target} outcome=${evidence.outcome} model=${modelKey(current)} → small=${modelKey(small)}`)
            } catch (error) {
              header = `(could not switch to ${modelKey(small)}: ${errorMessage(error)}; answering on the session's own model)`
              log(`switchModel failed for ${sessionID}: ${errorMessage(error)}`)
            }
          }

          const text = [
            `/wtf ${header}`,
            "",
            INSTRUCTION,
            "",
            "=== evidence ===",
            evidence.text,
            "=== end of evidence ===",
          ].join("\n")
          debug(`prompting ${sessionID} with ${text.length} chars of evidence`)
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!END_EVENTS.has(event.type)) continue
          const id = (event as any).data?.sessionID as string | undefined
          if (id && pending.has(id)) await restore(id, event.type)
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event subscription ended: ${errorMessage(error)}`)
      }
    })()

    return () => {
      controller.abort()
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
    }
  },
}

export default plugin
