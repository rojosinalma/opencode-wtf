# opencode-wtf

An [OpenCode](https://opencode.ai) plugin that registers a `/wtf [ses_…]` command explaining why the
previous turn of a session stopped: provider error, rate limit, content filter, interrupt, server
restart or a normal stop. The evidence — finish reasons, errors, retries, failed tools, model and agent
switches, pending inbox items and the matching server journal window — is read from OpenCode's
SQLite database (read-only) and `journalctl`, never from message text. The explanation runs on the
configured small model, so the outage that killed the previous turn cannot kill the explanation, and
the session's own model is restored when that turn ends.

## Install

Clone into the global plugins directory; it is auto-discovered and runs on its defaults:

```sh
git clone https://github.com/rojosinalma/opencode-wtf ~/.config/opencode/plugins/wtf
```

Reference the same path from `opencode.jsonc` only to change options (never a second copy):

```jsonc
{
  "plugins": [
    { "package": "./plugins/wtf", "options": { "journal_lines": 40, "debug": false } }
  ]
}
```

No runtime dependencies: SQLite comes from `bun:sqlite`, `@opencode/plugin` is imported as types only.

## Options

| key | default | meaning |
|---|---|---|
| `max_evidence_bytes` | `8192` | cap on the evidence block handed to the model |
| `journal_lines` | `40` | journal lines included around the failing turn |
| `error_chars` | `300` | truncation of each error message |
| `restore_timeout_ms` | `600000` | how long to wait for the explaining turn before restoring the model anyway |
| `small_agent` | `title` | agent whose model is used as the "small model" |
| `debug` | `false` | verbose logging |

## How it works

1. `ctx.command.transform` registers `/wtf`; the argument may name another session (`ses_…`), default is the invoking one.
2. `evidence.ts` opens `$XDG_DATA_HOME/opencode/opencode.db` read-only, finds the last ended turn and collects the fields above plus `journalctl --user -u opencode` for its time window.
3. The prompt is run on the small model; `[wtf]` log lines show the model switch and restore.

## Caveats

- Assumes a Linux host with the server as a systemd **user** unit named `opencode` (`journalctl --user -u opencode`); elsewhere the journal section reads "unavailable" and the rest still works.
- Loaded per location boot; running locations keep the plugin set they started with.
