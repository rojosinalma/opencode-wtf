# opencode-wtf

[![run-tests](https://github.com/rojosinalma/opencode-wtf/actions/workflows/run-tests.yml/badge.svg)](https://github.com/rojosinalma/opencode-wtf/actions/workflows/run-tests.yml)
[![release](https://img.shields.io/github/v/release/rojosinalma/opencode-wtf)](https://github.com/rojosinalma/opencode-wtf/releases)
[![license](https://img.shields.io/github/license/rojosinalma/opencode-wtf)](LICENSE)

An [OpenCode](https://opencode.ai) plugin that registers a `/wtf [ses_…]` command explaining why the
previous turn of a session stopped: provider error, rate limit, content filter, interrupt, server
restart or a normal stop. The evidence — finish reasons, errors, retries, failed tools, model and agent
switches, pending inbox items and the matching server journal window — is read from OpenCode's
SQLite database (read-only) and `journalctl`, never from message text. The explanation runs on the
configured small model, so the outage that killed the previous turn cannot kill the explanation, and
the session's own model is restored when that turn ends.

Configuration, design and troubleshooting are documented in [`docs/`](docs/).

## Requirements

- [OpenCode](https://opencode.ai) ≥ 2.0, running on [Bun](https://bun.sh) ≥ 1.4 (the plugin uses
  `bun:sqlite`; no runtime dependencies).
- Read access to OpenCode's SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`, or the path in
  `OPENCODE_DB`).
- Optional: Linux with systemd, the OpenCode server running as a systemd **user** unit and
  `journalctl` on `PATH`. Without them the journal section of the evidence is replaced by one
  explanatory line and everything else still works.

## Installation

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

## Usage

Type `/wtf` in a session whose last turn ended without a reply (or `/wtf ses_…` for another
session). The next assistant message is a short explanation of what stopped the turn — the provider
error, the rate limit, the content filter, the interrupt or the server restart — with the evidence it
rests on. `bin/wtf-evidence [ses_…]` prints the same evidence block from a shell without involving a
model. Every option is listed in [`docs/configuration.md`](docs/configuration.md); `journal_unit`
names the systemd user unit the server runs as (`""` drops the journal section).

## Development

```sh
bun install          # @opencode/plugin types only
bun test
```

Tests live under `test/` and run on every push and pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md) for layout, style and the release flow.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Copyright (C) 2026 rojosinalma.
