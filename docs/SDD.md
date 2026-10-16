# Software design document

## Purpose

When a turn in an OpenCode session ends without a reply, the UI rarely says why: a provider 429, a
content filter, a user interrupt and a server restart all look the same. `/wtf` answers the question
from evidence that already exists — the session's message metadata in OpenCode's SQLite database and
the server's journal — and has a model phrase it. Two constraints shape the design:

1. **Never feed message text back.** A content-filter stop must not re-trigger when the evidence is
   handed to a model, so only finish reasons, error objects, tool names and their error strings,
   timestamps and model ids are collected.
2. **The explanation must not die of the same cause.** The prompt runs on the configured small model
   and the session's own model is restored afterwards.

## Architecture

Two files, no runtime dependencies:

| file | role |
|---|---|
| `index.ts` | the OpenCode plugin: option resolution, the `/wtf` command, model switch and restore, event subscription |
| `evidence.ts` | pure evidence gathering from SQLite + journal, shared with `bin/wtf-evidence` |
| `bin/wtf-evidence` | CLI that prints the same evidence block for a session |

Hooks used (`@opencode/plugin`, imported as types only):

- `ctx.command.transform` — registers the `wtf` command. Its `execute` gathers the evidence, resolves
  the models, optionally calls `ctx.session.switchModel`, then `ctx.session.prompt` with the
  instruction + evidence.
- `ctx.event.subscribe` — watches `session.execution.succeeded|failed|interrupted` and `session.idle`
  to restore the model of a session the plugin switched.
- `ctx.agent.get`, `ctx.session.get`, `ctx.model.default` — read-only lookups for the small model and
  the session's current model.

The plugin writes nothing: the database is opened read-only, the only mutations are the two
`switchModel` calls on the invoking session.

## Data model / storage

Read from `opencode.db` (`$XDG_DATA_HOME/opencode/opencode.db`, overridable with `OPENCODE_DB`):

- `session_v2` — `title`, `directory`, `model`, `agent`, `parent_id`, `time_updated` (newest session
  for the CLI default).
- `session_message` — all rows of the session ordered by `seq`; the `type` column (`user`,
  `assistant`, `idle`, `model-switched`, `agent-switched`, …) and the JSON `data` column (for
  assistants: `time`, `agent`, `model`, `finish`, `rawFinish`, `error`, `retry`, `content` part types
  and tool states; for `idle`: `outcome`, `error`).
- `session_pending` — queued inbox items (`type`, `delivery`, `time_created`).

Plugin-side state is one in-memory `Map<sessionID, {previous model, timer}>` of sessions whose model
is awaiting restore. It lives for the plugin instance only; a server restart drops it (see
`docs/troubleshooting.md`).

## Key flows

### `/wtf [ses_…]`

1. `sessionArg` picks a `ses_…` token from the prompt text; default is the invoking session.
2. `gather(target, options)` (`evidence.ts`):
   - loads session, messages and pending rows;
   - finds the **last ended turn**: the rows from the last `user` row up to the last `idle` row. If
     `user`/`assistant` rows follow the last `idle`, that turn never ended — it is marked
     `unfinished` and explained instead (a recent last row means "may still be running", an old one
     "killed mid-step, likely a server restart");
   - emits one line per assistant step (time, model, agent, `finish`/`rawFinish`, completion, error,
     retry, part counts, tool errors), model/agent switches, other row types, pending inbox items and
     the session's current model/agent;
   - appends the journal window (below) when `journal_unit` is set;
   - caps the whole block at `max_evidence_bytes` (`capBytes`).
3. The current model is resolved from the session row, else from the last step's model, else from
   `ctx.model.default()`; the small model from the `small_agent` agent.
4. If they differ, `switchModel` to the small model, record the previous one with a
   `restore_timeout_ms` timer, and say so in the prompt header. Failures to switch are reported in
   the header and the prompt still runs.
5. `ctx.session.prompt` with a fixed instruction (category, concrete cause quoting the evidence, what
   to do next; no tools; never guess message text) and the evidence block.
6. On the turn's end event or the timer, `switchModel` back and log `[wtf] restored model …`.

### Journal window

`journalWindow` runs `journalctl --user -u <journal_unit> -o short-iso --since <turn start − 5 s>
--until <turn end + 5 s>`. `selectJournalLines` then keeps a line when it carries the session id or
matches a pattern: the built-in set (`[wtf]`, `level=WARN`, `level=ERROR`, systemd `Started`,
`Stopping`, `Stopped`, `Deactivated`, `Main process exited`, `Scheduled restart`) plus the configured
`journal_patterns` (companion plugins' prefixes by default). Known noise (`spawning process`,
`watcher subscribe`) is dropped, the process preamble and request ids are stripped
(`compactJournalLine`), and the list is capped at `journal_lines`. A missing `journalctl`, a failing
call or an unknown unit yields a single explanatory line so the rest of the evidence is unaffected.

## Configuration surface

All options are read once at `setup` from the `plugins[]` entry (`resolveOptions` in `index.ts`):
`max_evidence_bytes`, `journal_lines`, `error_chars`, `journal_unit`, `journal_patterns`,
`restore_timeout_ms`, `small_agent`, `debug`. Environment: `OPENCODE_DB`, and for the CLI
`OPENCODE_SESSION_ID` and `WTF_JOURNAL_UNIT`. Full table in `docs/configuration.md`.

## Decisions and rationale

- **Metadata only, never message text** — the evidence may be fed to a model that just refused
  similar content; finish reasons and error objects are enough to classify a stop.
- **Direct SQLite read instead of the server API** — the plugin runs inside the server and the
  database is the one place that still has the row for a turn killed mid-step; `bun:sqlite` makes it
  dependency-free and the read-only open guarantees no writes.
- **Explain on the small model** — the usual trigger is a throttled or failing main model, so the
  explanation would otherwise fail the same way. Restoring on the end event with a timer fallback
  keeps the session on its own model without relying on the event arriving.
- **Journal via `journalctl --user`** — the lifecycle lines (`Stopping`, `Started`) are the only
  evidence of a server restart; the section degrades to one line where there is no user journal
  instead of failing the command.
- **Companion patterns as an option** — which other plugins log decisions that end a turn depends on
  the installation; the defaults name the common ones and `journal_patterns` replaces them.
- **`import type` from `@opencode/plugin`** — the plugin directory may have no `node_modules`; types
  are erased at load and nothing is needed at runtime.

## Current scope and non-goals

The plugin explains the last ended (or in-flight) turn of one session from local evidence. It does not
alter how turns run, does not retry or switch models for the failing turn itself (companion plugins
do that), does not read remote logs, and keeps no history of its own. Journal evidence is read from
the systemd user journal; other log sources are not consulted today.

## Operations

- **Logs**: `[wtf] …` lines on the server's stderr/journal — the model switch, restore (with the
  reason: event type or `timeout`), failures to switch or resolve the small model; `debug: true` adds
  prompt sizes and lookups.
- **Health**: `/wtf` appearing in the command list shows the plugin loaded; `bin/wtf-evidence`
  exercises the gathering path without a model.
- **Upgrade**: `git pull` in the plugin directory; the server picks the new code up when a location
  boots (new session in a fresh location, or a server restart). Options are backwards compatible —
  unknown keys are ignored, missing keys take the defaults.
- **Tests**: `bun test` (see `CONTRIBUTING.md`).
