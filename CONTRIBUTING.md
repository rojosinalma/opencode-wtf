# Contributing

## Running it locally

Clone the repo into an OpenCode plugins directory and start (or restart) an OpenCode 2.x server;
plugins load when a location boots, so a fresh session in a new project directory picks up edits:

```sh
git clone https://github.com/rojosinalma/opencode-wtf ~/.config/opencode/plugins/wtf
bun install          # types only (@opencode/plugin); the plugin itself has no runtime dependencies
```

Add a `plugins[]` entry in `opencode.jsonc` pointing at the same path to change options (see
`docs/configuration.md`); `debug: true` logs every step as `[wtf] …` on the server's stderr. Type
`/wtf` in a session to exercise the full path, or run `bin/wtf-evidence [ses_…]` to see the evidence
block without involving a model (`OPENCODE_DB=/path/to/opencode.db` points it at another database).

## Tests

```sh
bun test
```

`test/evidence.test.ts` covers the pure parts: evidence truncation (`capBytes`), journal-line
selection and compaction (`selectJournalLines`, `journalLineMatches`, `compactJournalLine`,
`compileJournalPatterns`), option resolution and `sessionArg`, and `gather()` against a fixture
SQLite database built in a temp dir (normal stop, interrupt, provider failure with retry and model
switch, unfinished turn, unknown/empty session). Tests never call `journalctl` — the fixture runs
with `journal_unit: ""`. The suite runs on every push and pull request
(`.github/workflows/run-tests.yml`).

## Code style and layout

- `index.ts` — the plugin: option resolution, the `/wtf` command, model switch/restore, event
  subscription. Hook callbacks never throw into the server: every failure is logged and the command
  still prompts.
- `evidence.ts` — evidence gathering, kept free of plugin context so the CLI and the tests can use
  it. The pure helpers are exported; the only side effects are the read-only SQLite open and the
  `journalctl` spawn.
- `bin/wtf-evidence` — thin CLI over `gather`.
- TypeScript on Bun, no build step, no runtime dependencies. Two-space indent, no semicolons, double
  quotes. Comments explain *why*; the evidence must stay metadata-only — never add message text to
  it.

## Commits and PRs

Plain, descriptive commit messages in the imperative ("Add journal_patterns option"). One logical
change per commit. Open a pull request against `main`; `run-tests` must be green. Document a new
option in `docs/configuration.md` and, if it changes a flow, in `docs/SDD.md`.

## Documentation

- `README.md` — what it is, requirements, setup, licence. Nothing else goes there.
- `docs/configuration.md` — every option, environment variable and the CLI.
- `docs/SDD.md` — design: hooks, data read, flows, decisions, operations.
- `docs/troubleshooting.md` — symptoms and their fixes.
- `CONTRIBUTING.md` — this file.
