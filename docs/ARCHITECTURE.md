[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

# System Architecture

Summon Bot is a locally self-hosted multi-Bot group collaboration platform backed by a single formal data root (`D:/Relay-Bot-data`) and a unified runtime gateway. The Web process handles authentication, static web assets, client release queries, and API/SSE forwarding; the local loopback gateway hosts platform object handlers, the Bot runtime (embedded Pi Agent), and external execution connectors.

## 1. Module Layout

| Module | Responsibility |
| --- | --- |
| `capabilities/gateway` | Loopback gateway, `/api/*` routing, SSE event streaming, and production APNs push queue |
| `capabilities/platform` | Protocol 3 (`X-Summon-Protocol: 3`) object contracts & handlers: Bot, Room, Event, File, Session, Conversation, Call, Wait, Wakeup, Connection, Workspace |
| `capabilities/chatroom` | Room membership, messages, replies, attachments, pins, and shared state DB (`capabilities/chatroom/state.sqlite`) |
| `capabilities/bot-management` | Bot creation, default role provisioning, synchronous Group Lead creation, revision control, and pause/resume |
| `capabilities/models` | Model connection catalog, purpose-based routing table, credential storage, and provider quota snapshots |
| `capabilities/services` & `capabilities/connectors` | Real invocations, process management, and native input targets for Codex App Server, Grok Build, Claude Code, local CLI, SSH, MCP, and HTTP |
| `bot/src` | `BotRuntime`, `FastReadRuntime`, Pi engine, context projection & trunk/fork management, material index, and token ledger (`usage.sqlite`) |
| `roles` & `skills` | 5 built-in role instructions (`roles/index.mjs`) and execution onboarding guide (`skills/summon-execution-onboarding/SKILL.md`) |
| `web`, `desktop`, `ios`, `android` | Standard Web app (Paper / Midnight), Electron Desktop shell, SwiftUI native iOS 26 client, and Jetpack Compose native Android client |
| `scripts` | Release builder (`scripts/build`), formal installer & watchdog (`scripts/installation`), maintenance (`scripts/maintenance`), and multi-platform release CLI (`scripts/release`) |

## 2. Chat & Work Separation (Three-Layer Runtime)

To eliminate noisy Bot pile-ons and prevent heavy coding/tooling runs from freezing group chat, every Bot's execution in a room is split into three distinct layers:

1. **Layer 1 · Fast-Read Triage (`FastReadRuntime`, purpose: `fast_read`)**
   - Runs by default with reasoning disabled (`thinking_level: "off"`) and zero write access.
   - Reads newly arrived public room messages in batches and makes a binary routing decision per message: `quiet` (unrelated to this Bot's duty—stay silent) or `main` (hand off to the room's main conversation and emit a short live `activity` status string shown right above the composer).
   - If fast-read cannot run due to missing model grants or parse failures, it safely falls back to `main` so no messages are silently dropped.
2. **Layer 2 · Main Room Conversation (purpose: `conversation`)**
   - **Single public voice**: In a room conversation, the assistant's final plain text at the end of a turn is strictly internal and never shown to the room. Public replies must explicitly invoke the `send` tool (supporting `reply_to`, attachments, references, `@mentions`, and interactive choice/permission `prompt` cards).
   - Coordinates task breakdown, replies to users, sends `steer` / `next` / `reply` inputs to active background sessions, receives asynchronous receipts, and delivers verified conclusions back to the originating room.
   - If concurrent room messages arrive mid-composition (`room_sequence_changed`), the Bot reads the new messages first and either posts only the missing delta/correction or stays silent.
3. **Layer 3 · Background Execution Sessions (Standalone `pi_session` & External Executors)**
   - The main conversation launches standalone Pi sessions or external Codex, Grok Build, Claude Code, CLI, SSH, MCP, and HTTP runs via `open_session`.
   - **Code-enforced hard gate (`403 room_send_forbidden`)**: Only a Bot's main room conversation can publish messages to a room. Background execution sessions cannot post directly to rooms (their `send` tool is restricted to `{ kind: "connection", id }` for verified connection repair requests). Results return to the immediate parent via platform `wait_ref` receipts for verification before public delivery.
   - Once `open_session` registers a `wait_ref`, the main conversation ends its turn silently—leaving foreground chat 100% responsive for new topics or mid-flight steering.

## 3. Platform Tool Contract (Protocol 3)

Client JSON APIs require `X-Summon-Protocol: 3` (streaming endpoints pass `?protocol=3`), and write retries carry the original `clientId` or `X-Summon-Client-Id` for idempotency. The embedded Pi runtime invokes 13 core platform tools via `platform.invoke`, plus `initialize_execution` when authorized:

| Tool | Purpose |
| --- | --- |
| `find` | Search accessible objects (`bot`, `room`, `event`, `file`, `session`, `wakeup`, `connection`, `conversation`, `call`, `wait`, `workspace`) and `connection_usage` stats |
| `read` | Inspect object details, history pages, session outputs, available input targets, file text/historical revisions/images (vision models), or any local host directory/file |
| `send` | Publish to a room (including interactive `prompt` single/multi/text/permission cards), or send/reply to a connection repair event (`{ kind: "connection", id }`) |
| `save_file` | Save or revision-update a platform File, copy a shared attachment, or write text to a local host directory |
| `create_bot` / `configure_bot` | Create a Bot or revision-update its name, `public_duty`, instructions, model binding, enabled flag, `role_id`, maintainer connection binding, or `material_index_ref` |
| `create_room` / `configure_room` | Create group/direct rooms; revision-update title, membership, pins, or bound project workspace |
| `open_session` / `configure_session` | Launch a standalone Pi or external execution session (with live `work_summary`); update session progress/waiting summaries |
| `send_input` / `stop_session` | Submit `reply`, `steer`, or `next` to an execution (targeting `codex_turn`, `pi_run`, `cli_process`, `service_call`, or `idle_input`); interrupt an in-flight run/turn and detach cleanly |
| `set_wakeup` | Create or update `room_base` observation rules, event subscriptions (such as `work.tool`), one-shot `time` reminders, or `recurring_time` schedules |
| `initialize_execution` | Read the bundled onboarding guide, discover/inspect local CLIs, inspect adapter scripts, register/update connections & methods, and assign dedicated maintainers |

## 4. Context Trunk, 5-Layer Priority & Persistent Memory

- **Stable Public Trunk + Private Turn Fork**: Public room messages append once in publish order with stable formatting across turns to maximize Prompt Cache hit rates; per-turn tool calls, mid-turn interjections, and async wakeups append to the private fork tail. When history exceeds the context window, only public room messages and the previous public summary enter compression—preserving active rules, open session/call references, and completed deliveries.
- **5-Layer Instruction Priority (bounded by non-overridable hard boundaries)**:
  1. Current-turn explicit request or correction (this delivery only)
  2. Confirmed room or project convention (this room/project only)
  3. Bot's individual persona & long-term user instructions (across rooms)
  4. Built-in role default (`roles/index.mjs`)
  5. General platform defaults
- **Persistent Material Index (`material_index_ref`)**: Bots can maintain a JSON index file in their private space and register it as `material_index_ref`. Each entry stores a stable `id`, `revision`, `applies_to` scope (room or Bot), `note` / `material_ref`, and `source_refs` so long-term user habits and room conventions survive context compaction.
- **Host Directory Autonomy**: Registered `workspace` entries serve as group defaults and bookmarks—not a directory cage. Bots can pass any absolute local host path to read, write, bind a group workspace, or launch sessions; only Summon's own runtime/install stores and host account credential files are protected.

## 5. Persistence & Further Reading

- Shared room, member, message, and platform records live in `capabilities/chatroom/state.sqlite`; each Bot's inbox, internal conversations, call receipts, and cursors live in `bots/<id>/state.sqlite`; the real model token ledger lives in `usage.sqlite`.
- Related guides:
  - [EggBot & Built-in Roles](EGGBOT.md)
  - [Model Routing & Execution Connections](MODEL_CONNECTIONS.md)
  - [Web & App Access Authentication](WEB_AUTH.md)
  - [Operations & Maintenance](OPERATIONS.md)
