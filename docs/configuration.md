# Configuration

Options go into the plugin's `plugins[]` entry in `opencode.jsonc`. Every key is optional; omit the
entry entirely to run on the defaults.

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/wtf",
      "options": {
        "max_evidence_bytes": 8192,
        "journal_lines": 40,
        "error_chars": 300,
        "journal_unit": "opencode",
        "journal_patterns": ["\\[model-fallback\\]", "\\[question-gate\\]"],
        "restore_timeout_ms": 600000,
        "small_agent": "title",
        "debug": false
      }
    }
  ]
}
```

| key | default | meaning |
|---|---|---|
| `max_evidence_bytes` | `8192` | cap on the evidence block handed to the model (UTF-8 bytes); a cut block ends in `(evidence truncated)` |
| `journal_lines` | `40` | journal lines included around the failing turn; the rest is summarised as `(N more journal lines omitted)` |
| `error_chars` | `300` | truncation of each error message (provider, retry, tool, idle) |
| `journal_unit` | `opencode` | systemd **user** unit the server runs as (`journalctl --user -u <unit>`); `""` drops the journal section |
| `journal_patterns` | `["\\[model-fallback\\]", "\\[question-gate\\]"]` | extra regular expressions (JSON strings) selecting journal lines in the turn's window — by default the log prefixes of companion plugins whose decisions can end a turn. Lines carrying the session id, `[wtf]`, `level=WARN`/`level=ERROR` and systemd lifecycle messages are always included; an invalid pattern is skipped |
| `restore_timeout_ms` | `600000` | how long to wait for the explaining turn to end before restoring the session's model anyway |
| `small_agent` | `title` | agent whose model is used as the "small model" (OpenCode normalises `small_model` into this agent's model) |
| `debug` | `false` | verbose `[wtf]` logging (prompt size, model resolution) |

Number options accept numbers or numeric strings. `journal_patterns` must be an array; non-string
items are dropped and a non-array value falls back to the default list.

## Environment

| variable | effect |
|---|---|
| `OPENCODE_DB` | path of the SQLite database; default `$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode/opencode.db`) |
| `OPENCODE_SESSION_ID` | default session for `bin/wtf-evidence` when no id is given |
| `WTF_JOURNAL_UNIT` | `bin/wtf-evidence` only: overrides `journal_unit` (`""` disables the journal section) |

## CLI

`bin/wtf-evidence [ses_…]` prints the exact evidence block the `/wtf` command feeds its model, for
the given session, else `$OPENCODE_SESSION_ID`, else the most recently updated session. It runs on
the defaults above (plus the environment overrides) and needs Bun on `PATH`. Symlink it somewhere on
`PATH` to use it from anywhere:

```sh
ln -s ~/.config/opencode/plugins/wtf/bin/wtf-evidence ~/.local/bin/wtf-evidence
```
