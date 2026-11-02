# Pi sources used by @relay/bot

The original files in `upstream/` come from earendil-works/pi v1.3.0, commit
`71023aec1546d6d677a65669c5665c0927ce0dd0`. Every selected file was compared byte for
byte with `sourcesContent` in the npm 1.3.0 release source maps. See `SOURCES.json`
for original SHA-256, paths, runtime derivatives and individual changes.

Copyright (c) 2025 Mario Zechner. The complete MIT license is in `LICENSE`.
The former upstream tests and local executable copies are available in Git history.
They are not part of the current development workflow and must not be restored or
run unless the user explicitly requests it.

`src/pi/` is editable runtime source, not a generated build directory. TypeScript
was erased once using Node 24.15.0 `stripTypeScriptTypes(mode: transform)`; runtime
execution needs only ESM JavaScript. Do not rerun a full importer over local edits.
Use the upstream reference, a chosen new upstream commit and local code for selective
three-way updates. Recorded source hashes are historical provenance, not a required
development check.

Local boundaries: no Pi CLI/TUI, JSONL database, home-directory discovery, package
manager, login flow or background model-catalog refresh is imported. Source
session-manager contains current-format context projection only. Bot uses its SQLite
state. Relay uses Pi message projection, token estimates and tool execution.
Context compaction now runs a fresh temporary dialogue in
`src/context/maintenance.mjs`, writing the current work's Markdown; the previous
SQLite-summary lifecycle adapter has been removed. Original raw messages and
recovery edits remain durable, and transient model failures still retry without
replaying completed tools.

See `LOCAL_CHANGES.md` and `DEPENDENCIES.json` for adaptation and installed package
license records. Public package behavior is documented in ../../README.md.
