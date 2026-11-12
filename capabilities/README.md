# External capabilities

`startGateway({dataRoot,releaseRoot,defaultCwd,model,token,host,port})` starts an authenticated loopback service. It returns `url`, `token`, `manager`, `chatroom`, `knowledge`, `memories`, `state`, `handleApi`, and `close`. It never creates an Agent inside the capability process. Bot processes use the independent `@summon/bot` package.

The Web backend forwards approved `/api/*` calls with its controller token. Stateful services each own `dataRoot/capabilities/<name>/state.sqlite`; the shared `RecordStore` supplies storage mechanics only. Public attachment content belongs to chatroom. Private transcripts, memory, tasks and tool artifacts belong to `dataRoot/bots/<botId>`. Capability tokens are not included in public Bot projections.

Bot roles configure HTTP tools at `POST /tools/<name>` with `{arguments}` and a Bot-specific token. `POST /mcp` implements MCP JSON-RPC initialization and tool discovery/calls using Streamable HTTP; it is tested with the official MCP SDK client. Skill documents are methods and do not execute operations themselves. `/api/*` and `/internal/*` require controller authentication.

System stop explicitly calls `POST /internal/bots/stop-all` before closing the capability gateway. Closing Web has no effect on Codex or Bots. Gateway close stops its own delivery/timer/Codex processes but leaves independent Bots running; interrupted external operations are not replayed. Known peer Bots can communicate directly without the gateway.

Temporary Bot cloning is an external logical SQLite read transaction. Only selected sessions and memories are initialized in the new identity; no inbox, tasks, outbox, PID, locks or credentials are copied. Creation receipts live in bot-management. Delivery receipts retain result text, memory deltas and artifacts independently of the parent. Memory proposals live in memory-management and apply ordinary revision-checked writes; conflicts require an explicit resolution. Recycling marks a completed child archived, writes its archive index and preserves its original data directory while artifacts/history may reference it. It never deletes an external project.

`RecordStore.import(kind, record)` preserves imported timestamps. Imports must choose authoritative execution records before writing; UI projections must not overwrite a Bot's own task facts. Historic jobs imported into the capability delivery collection must be terminal/interrupted unless their ownership and nonexecution are confirmed.

Tests distinguish deterministic protocol fixtures from live execution. `npm test --workspace @summon/capabilities` covers filesystem behavior, real child-process cancellation, Codex RPC fixtures, user-only questions, MCP interoperability, consistent clones, offline delivery, conflicts, idempotence and artifact ownership. Real model and real Codex evidence is collected by the integration suite.
