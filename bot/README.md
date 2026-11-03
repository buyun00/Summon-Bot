# @summon/bot

A standalone Bot using Pi Agent 1.3.0, with isolated Agents per active conversation, SQLite transcripts and persistent work state. It has no dependency on the Summon Bot website, rooms, filesystem tools, process manager or other business services. It never creates or copies another Bot. API, module and MCP tools are explicit configuration.

Requires Node.js 24 or later. From this directory run `npm install` when dependencies are needed. `npm pack` produces an independently installable package. Install the tarball in another project with `npm install /path/summon-bot-0.2.0.tgz`; copy `examples/config.json` to your own location, set its model endpoint/model and the named `BOT_MODEL_API_KEY` environment variable, then run `npx summon-bot --config /absolute/path/config.json`. No repository `.env` or another application's credentials are discovered. Relative configuration paths resolve against the config file. Development does not require tests or hash comparisons; follow the repository's `AGENTS.md`.

`node node_modules/@summon/bot/examples/start.mjs /absolute/path/config.json` is a minimal complete start/send/query/close example. It calls a real model; run it only when that operation is requested.

## Public interface

The package exports `startBot(config, options?)`, `loadBotConfig(path)`, `normalizeBotConfig(config)`, `BotStore`, `inspectBotIdentity(dataDir)`, `withBotDataLease(dataDir,operation,options)`, `requestBot`, `sendMessage`, `waitForTask`, `saveArtifact`, and `terminalTaskStates`. `@summon/bot/store` exports the store; `@summon/bot/tools` exports the generic ToolRegistry and jsonToolResult; `@summon/bot/process-log` exports the process log writer and explicit stdout/stderr capture.

`startBot` returns `{config, store, url, bootId, engine, health(), close(), emit(type,payload,refs), subscribe(listener)}`. It always constructs the Pi Agent; custom app factories are rejected. Model credentials missing at startup appear as `engine.configured:false`, and execution returns HTTP 503. Business execution uses `concurrency:4` by default and is serial within each conversation. Independent work has independent Agent state. A separate maintenance lane defaults to one slot. Waiting consumes no Agent slot; durable incoming events resume the same work. No model is called for unchanged external state.

The required config fields are `botId`, `dataDir`, and `model:{provider,model,baseUrl,apiKey|apiKeyEnv,contextWindow?,maxTokens?,thinkingLevel?}`. Optional fields include `workspace`, `prompt`, `promptFile`, `skills:[absolutePath]`, `promptPaths:[absolutePath]`, `tools`, `peers:[{botId,token}]`, `contacts:[{botId,url,token}]`, `token`, `listen:{host:'127.0.0.1',port:0}`, and `concurrency`, `context:{maxSummaryTokens:8192,maxAssemblyTokens:6144,maintenanceConcurrency:1,maintenanceDelayMs:3000}`, and `limits:{reserveTokens,keepRecentTokens}`. The listener is restricted to IPv4/IPv6 loopback. The management token is generated if absent and preserved in private `dataDir/config.json`; protect access to that directory.

Model budgets default to `contextWindow:1048576` (1M tokens) and `maxTokens:393216` (384K tokens), matching DeepSeek Flash. Explicit model budgets override these defaults.

Compaction, organization and assembly each create a fresh temporary Pi dialogue only when needed. Markdown under `dataDir/knowledge` is the only summary body; SQLite keeps scope indexes and processing cursors. Assembly is temporary input, not a persisted context pack. Original messages and tool receipts stay in SQLite. Current instructions and unorganized tails enter execution immediately. Failed maintenance retains the prior usable context and pending records. Actual model budgets include system instructions, tools, content and output reserve; oversized unrecoverable input is reported without replaying side effects. Reusable observed methods can update private Skills under `dataDir/skills`; Skill bodies are read on demand.

Every HTTP endpoint requires `Authorization: Bearer TOKEN`. Management authentication identifies the sender as `controller`; an inbound peer token identifies its configured peer Bot. Supplied `from` must agree. Peers may submit messages and read/cancel only their own tasks; memories, history, state and global events require management authentication. Secrets are never included in health, events or task results.

| Endpoint | Behavior |
| --- | --- |
| GET /health, /capabilities | Observed identity, actual engine state, configured tools and skills |
| POST /messages | `{id,to,kind:'request'|'event',content,conversationId?,workId?,sessionId?,replyTo?,correlationId?,metadata?}` → HTTP 202 `{accepted,duplicate,messageId,taskId,status}` |
| GET /tasks, /tasks/:id | Task state/result; detail includes audited `tools` |
| POST /tasks/:id/cancel | Cancel queued/running work; retain uncertain effects |
| GET /messages | Persisted inbox |
| GET /events?after=N | Ordered durable events; `stream=1` or SSE Accept header subscribes from the cursor |
| GET /sessions, /sessions/:id | Complete original transcript and lossy checkpoints |
| GET /state/:scope/:key | Versioned local state; omit key to list scope |
| PUT /state/:scope/:key | `{value,expectedRevision?}` |
| GET/POST /works, GET/PATCH /works/:id | Persistent goal, requirements, progress, wait, sources and external bindings |
| POST /works/:id/events | Durable deduplicated input for the same work |
| GET /knowledge, /knowledge/:id | Markdown directory or bounded document body |
| POST /knowledge | Rewrite/create Markdown with optional expectedRevision |
| GET /tools, /tools/:id | Complete audited tool receipt |
| GET /artifacts, /artifacts/:id | Metadata including owned path, SHA-256, size and task correlation; external gateway owns download policy |
| PATCH /config | Management-only `{prompt}` persists a prompt for restart; serialized with capability commits so concurrent updates preserve tools and binding markers |
| POST /capability-updates/prepare | Management-only `{id,bindingRevision,tools,bundledToolNames?,reason?}` stages a complete replacement and returns HTTP 202 without waiting for active work |
| GET /capability-updates/:id | Public metadata for `preparing`, `ready`, `committed` or `failed`; credentials and tool definitions are excluded |
| POST /capability-updates/:id/commit | Persist and activate a ready toolset at the held task boundary; repeat commits are idempotent |
| POST /capability-updates/:id/abort | Release the boundary and keep the previous tools; records `failed` with `CAPABILITY_UPDATE_ABORTED` |
| POST /shutdown | Close this Bot only; no implicit contact shutdown |

Task states are `accepted`, `running`, `completed`, `failed`, `cancelled`, `interrupted`. A completed result is `{content,model,usage,turns,toolsCalled}` with free-text content. Receipt acceptance is not final execution or delivery. `(authenticated sender,id)` deduplicates forever; retrying an uncertain send must reuse its message ID. Task IDs, run IDs, stable conversation IDs and work IDs are distinct. Outbox stores accepted/unknown delivery, and never resends automatically. Restart marks running tasks interrupted and in-flight tools unknown. Accepted unstarted input is scheduled; responsible work resumes by inspecting durable receipts and original external bindings, never by replaying the interrupted tool.

## Configured tools and skills

A message can narrow its tools using `metadata.toolPolicy.allowedEffects:['read']`; the registry enforces this before every tool, including built-in state, memory and messaging mutations. During model or tool I/O, `health.engine.activity` is `waiting` and `waitingFor` identifies the model or tool; task status remains `running` until the actual task completes or is interrupted.

HTTP tool: `{type:'http',name,description,inputSchema:{type:'object',properties:{}},effect:'read'|'write'|'external'|'process',url,method:'POST',headers?,headersEnv?:{Authorization:'ENV_NAME'},bodyMode?:'arguments'|'raw',timeoutMs?}`. Default body is `{arguments:args}`. Responses preserve Pi `{content,details,isError,artifacts}`; other JSON becomes text/details. Redirects are rejected. Abort or timeout during a side effect records unknown, with no implicit retry.

MCP tool source: `{type:'mcp',transport:'stdio',command,args?,env?,namePrefix?,timeoutMs?}` or `{type:'mcp',transport:'http',url,headers?,headersEnv?,namePrefix?,timeoutMs?}`. This uses the official MCP SDK, initialize/listTools (including pagination)/callTool and Streamable HTTP or stdio transport. Explicit stdio environment entries may use `{env:'ENV_NAME'}`; arbitrary parent secrets are not inherited. Images, content arrays and protocol/tool errors are preserved.

Module source: `{type:'module',module:'/absolute/trusted/file.mjs',exportName:'createTools',options?}`. The exported factory receives `(context, options)` and returns tools or `{tools,close}`. A tool is `{name,description,inputSchema,effect,execute(args,context)}`. Context supplies `signal`, `taskId`, `sessionId`, `runId`, `toolCallId`, `emitProgress`, and `saveArtifact({name,mimeType,content|path})`. Modules are trusted code, not a security sandbox.

Built-ins are `messages_send`, `messages_list`, `tasks_get`, `tasks_list`, `state_get`, `state_set`, `works_list`, `work_get`, `work_create`, `work_update`, `work_dispatch`, `work_wait`, `work_notify`, `knowledge_list`, `knowledge_read`, `knowledge_write`, `skills_list`, `skill_write`, `artifact_save`, `read_resource`, `read_session_history`. Filesystem/command/business tools are deliberately configured externally. Skills are explicit files/directories loaded with Pi's Skill rules, recorded in health and events. `/skill:name arguments` loads a Skill; model-directed `read_resource` stays inside declared Skill roots. Skill prose cannot grant additional tools or access.

An external capability controller owns service versions and publication. To switch this Bot without interrupting a task, it submits the entire next configured `tools` array to `/capability-updates/prepare`. All active tasks retain their existing tools for every model/tool round; further accepted tasks wait at the boundary. The runtime loads and validates the candidate clients and tool declarations, then acknowledges `ready` after all active tasks finish. Readiness is the runtime's safe-boundary acknowledgment, not an extra model decision. Commit writes private `config.json` before activating the new toolset and releasing queued work. The next model request contains the current declarations and binding revision. Optional `bundledToolNames` must be a unique subset of the staged tool names and is persisted with the tools so an external manager can distinguish managed from custom tools on later startup.

Only one update may be pending. Reusing an ID requires the same payload; failed or aborted IDs retain their result, so retry with a new ID. Invalid candidates leave the active toolset unchanged. Preparation, readiness, commitment and failure are durable `capability.update.*` events. A normal shutdown aborts pending updates. After a crash, an unfinished update is only recovered as committed when the loaded private config has its matching update ID, binding revision and tool-definition hash; otherwise it is failed with `CAPABILITY_UPDATE_INTERRUPTED`. The external controller must reconcile its own routing and retry interrupted switches with a new ID. Service deployment, version retirement and in-flight external job draining remain outside the Bot package.

## Persistence and lifecycle

`dataDir/state.sqlite` is the single authoritative store for messages/tasks, sessions/checkpoints, tool facts, state, S3 work/indexes, outbox, events and artifact references. Artifact bytes live in `artifacts/`; summary/knowledge bodies live only in `knowledge/*.md` and learned methods in `skills/*/SKILL.md`. `run/current.json` is observational; OS-held named-pipe/socket ownership and a handshake determine liveness. The lock is acquired before opening the writer. A stale PID or config file never proves a running process, and an unavailable handshake is not treated as absence.

`new BotStore('/absolute/state.sqlite',{readOnly:false})` supports `getSession/listSessions/saveSession`, `getState/listState/setState`, `getTask/listTasks`, `getTool/listTools`, artifact methods, and `putRecord(kind,{id,...})/getRecord/listRecords` for ordinary historical record storage. Sessions use `{id,contextKey,messages,checkpoints,...}`. State, work records and sessions support expected revisions; Markdown writes are serialized per document. Only use writable offline import with the Bot stopped and ownership verified. Copying data into a new Bot is an external management responsibility; do not copy task execution, outbox, tokens or run identities.

Closing aborts current work, records its actual known/unknown state, closes configured clients and listeners, then releases store and OS lock. It does not claim an external asynchronous job was cancelled. Process restart, project scanning, task/artifact deletion and temporary-data cleanup remain external responsibilities.

The CLI records stdout/stderr in `dataDir/logs/process.log` after obtaining exclusive Bot ownership. Configure `logs:{maxFileBytes:10485760,maxFiles:5,retentionDays:7,sweepIntervalMs:60000}` to change the defaults: 10 MiB per file, at most 5 files including the active file, and 7-day retention. Writes rotate immediately at the byte limit on complete UTF-8 boundaries; daily rotation and periodic sweeps also expire idle logs. Only the writer's recognized log filenames are pruned. An existing oversized process log is reduced to its newest bounded text; original task/tool facts and artifacts are retained separately. The child owns logging and continues after its launcher exits.

Embedded `startBot(config)` does not intercept the host's output. A dedicated process host can explicitly use `startBot(config,{captureProcessOutput:true})`; only one capture owner can exist per process. Normal shutdown flushes and closes the log before releasing identity. A duplicate startup cannot rotate the active owner's log, and initialization errors release ownership and report failure.

External offline maintenance uses `withBotDataLease(dataDir, async () => { ... }, {botId,purpose})` to hold the same OS lock throughout validation and changes; another Bot startup is excluded until the callback finishes, including on error. `store.listUnfinishedTasks()` returns every accepted/running/interrupted task without the paginated history limit. Interrupted or unknown work must be resolved before external temporary-data cleanup. These ordinary data APIs do not implement Bot copying or merging.

Pi source provenance and MIT licensing remain in `third_party/pi/`. Historical tests are not part of the current delivery flow; follow AGENTS.md.
