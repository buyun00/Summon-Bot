# Local adaptation log

2026-10-19 initial import. All modules: TypeScript erasure and `.mjs` imports;
originals and MIT are preserved. The following adaptations are intentional:

- `session-manager`: only current-format context projection; no JSONL I/O,
  SessionManager class or filesystem session discovery.
- `skills`: explicit agentDir, deterministic directory order, no descendant
  symlink traversal, maximum discovery depth 20, 128 KiB source limit and robust
  scalar/null frontmatter handling. Relay disables Pi defaults and exposes a
  scoped read_resource tool for skill bodies and relative references.
- `prompt-templates`: no host config import, stable order, no descendant symlinks,
  128 KiB source limit and robust non-object frontmatter handling.
- `utils/paths`: no external commands to set cloud-sync attributes.
- `compaction/utils`: recognize Relay read_file/read_resource/write_file/edit_file
  names in file-operation summaries; existing Pi names remain supported.
- `compaction/index`: exports only compaction and utilities; branch summarization
  is not part of the selected runtime.
- Bot adapters (not upstream code) keep identity, explicit provider credentials,
  SQLite messages/checkpoints, cancellation and message deduplication.
  Workspace execution coordination belongs to configured external capabilities. Original messages remain available after
  compaction; summaries are explicitly lossy.

2026-10-21: These selected runtime modules, original references and tests moved
into the independently installable @relay/bot package without changing their
recorded bytes. Paths in SOURCES.json are relative to this package. No old Bot
application, social service or compatibility runtime is included.

Dependency versions and licenses are recorded from installed package metadata
and lock integrity. Missing license files are reported in the dependency record;
metadata alone is not described as a copied license text.

2026-10-29: Selected the native AgentSession compaction lifecycle methods from
the pinned 1.3.0 source into `src/pi/core/compaction/lifecycle.mjs`. Native
threshold/overflow/manual handling, retry classification and backoff are retained.
Relay adapters supply fixed-model credentials through its provider, SQLite entry
projection/checkpoints/context edits, and cancellation/events instead of CLI/TUI,
JSONL or extension discovery. The summary stream uses the provider directly and
keeps Relay's evidence-preservation instructions. Pi's default compaction and
retry settings replace the former byte gate and disabled retries. Original
`agent-session.ts` and `settings-defaults.ts` are retained in `upstream/core/`.
Unused session-format migration and JSONL parsing functions were removed from
the selected runtime; original upstream references remain documentation only.

2026-11-02: Replaced the Relay runtime lifecycle adapter with isolated Pi Agents
and fresh temporary organize/assemble/compact dialogues. Markdown is the sole
current summary body; no new SQLite summary checkpoints are written. Removed
`src/pi/core/compaction/lifecycle.mjs`; the prior import description above is
historical. Pi projection, recovery edits, original messages, tool execution and
token estimates remain in use. No tests, source-hash checks or model probes were
run for this change.
