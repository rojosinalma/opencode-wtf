# opencode-wtf

An [OpenCode](https://opencode.ai) plugin that registers a `/wtf [ses_…]` command explaining why the
previous turn of a session stopped: provider error, rate limit, content filter, interrupt, server
restart or a normal stop. The evidence — finish reasons, errors, retries, failed tools, model and agent
switches, pending inbox items and the matching server journal window — is read from OpenCode's
SQLite database (read-only) and `journalctl`, never from message text. The explanation runs on the
configured small model, so the outage that killed the previous turn cannot kill the explanation, and
the session's own model is restored when that turn ends.

Configuration, design and troubleshooting are documented in `docs/`.

## Requirements

- OpenCode 2.x running on Bun (the plugin uses `bun:sqlite`; no runtime dependencies).
- Read access to OpenCode's SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`, or the path in
  `OPENCODE_DB`).
- Optional: Linux with systemd, the OpenCode server running as a systemd **user** unit and
  `journalctl` on `PATH`. Without them the journal section of the evidence is replaced by one
  explanatory line and everything else still works.

## Setup

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

Type `/wtf` in a session (or `/wtf ses_…` for another one). `bin/wtf-evidence [ses_…]` prints the
same evidence from a shell.

## License

MIT — see [LICENSE](LICENSE).
