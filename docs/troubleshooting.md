# Troubleshooting

## The journal section says `(journalctl not found …)` or `(journalctl --user -u opencode failed …)`

The journal section needs a Linux host where the OpenCode server runs as a systemd **user** unit and
`journalctl` is on `PATH` of the server process. Without that the section carries one explanatory line
and the rest of the evidence is still produced. Fixes:

- The server runs under a different unit name: set `journal_unit` to it (see
  `docs/configuration.md`).
- The server runs as a **system** unit, in a container or on macOS/Windows: there is no user journal
  to read; set `journal_unit` to `""` to drop the section instead of the placeholder line.
- `journalctl` exits non-zero: the first line of its stderr is quoted in the placeholder — usually a
  permission problem (the server's user cannot read its own journal) or an unknown unit.

## `/wtf` is not offered in a session

Plugins are loaded when a location (project directory) boots. A location that was already running
when the plugin was installed keeps the plugin set it started with; open a new session in a fresh
location, or restart the server, to pick it up.

## `(no small_model configured; answering on the session's own model)`

OpenCode normalises `small_model` into the `title` agent's model; the plugin reads it from there
(`small_agent`). Set `small_model` in `opencode.jsonc`, or point `small_agent` at an agent that has
the model you want. Without it the explanation runs on the session's own model — which is exactly
the model that may be throttled or failing.

## The session stays on the small model

The model is restored when the explaining turn ends (`session.execution.*` events) or after
`restore_timeout_ms`. If the server restarted in between, the in-memory bookkeeping is gone: switch
the model back by hand. `[wtf] restored model …` in the server log confirms a restore; `debug: true`
adds the resolution steps.

## `No session ses_… in …` or `Session ses_… has no messages yet`

The database path is wrong (set `OPENCODE_DB`), the id was mistyped, or the session has not run a
turn. `bin/wtf-evidence` prints which file was opened.

## The evidence looks truncated

`max_evidence_bytes` (default 8192) caps the block; `journal_lines` and `error_chars` cap its parts.
Raise them if the interesting line is cut, or read the full output with `bin/wtf-evidence`.
