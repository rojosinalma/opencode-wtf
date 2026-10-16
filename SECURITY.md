# Security

## Reporting a vulnerability

Report security issues privately through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose *Report a vulnerability*, or go straight to
<https://github.com/rojosinalma/opencode-wtf/security/advisories/new>. Never file a public issue
for a security problem.

Include what the plugin does wrong, how to reproduce it, and the OpenCode and Bun versions involved.
You get an acknowledgement within a few days; the fix ships as a new release with a changelog entry
and the advisory is published once the release is out.

## Supported versions

The latest release receives security fixes. Older releases are not patched; upgrade to the latest
tag.

## Scope

The plugin reads OpenCode's SQLite database read-only and spawns `journalctl`. The evidence it hands
to the model is metadata only (finish reasons, errors, tool names, model and agent ids, journal
lines) and never message text; anything that makes message text or secrets leave the database through
the plugin is a vulnerability.
