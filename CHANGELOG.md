# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-16

First tagged release.

### Added

- `/wtf [ses_…]` command: explains why the previous turn of a session stopped (provider error, rate
  limit, content filter, interrupt, server restart or a normal stop) from metadata-only evidence read
  from OpenCode's SQLite database and the server's journal — never from message text.
- The explanation runs on the configured small model and the session's own model is restored when
  that turn ends.
- `bin/wtf-evidence [ses_…]` CLI printing the same evidence block from a shell.
- Options `max_evidence_bytes`, `journal_lines`, `error_chars`, `journal_unit`, `journal_patterns`,
  `restore_timeout_ms`, `small_agent`, `debug`; `OPENCODE_DB`, `OPENCODE_SESSION_ID` and
  `WTF_JOURNAL_UNIT` environment overrides.
- `journal_unit` option; the journal section degrades to one explanatory line when `journalctl` is
  not available.
- Test suite (`bun test`) covering evidence truncation, journal-line selection, option resolution
  and `gather()` against a fixture database; `run-tests` workflow.
- Documentation: `docs/configuration.md`, `docs/SDD.md`, `docs/troubleshooting.md`, CONTRIBUTING,
  SECURITY, Code of Conduct, issue and pull request templates.

### Changed

- Licence to AGPL-3.0.

[Unreleased]: https://github.com/rojosinalma/opencode-wtf/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rojosinalma/opencode-wtf/releases/tag/v0.2.0
