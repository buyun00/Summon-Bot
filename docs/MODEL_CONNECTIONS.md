[English](MODEL_CONNECTIONS.md) | [简体中文](MODEL_CONNECTIONS.zh-CN.md)

# Model Routing & Execution Connections

Summon Bot separates **model connections** (powering Pi reasoning and conversation) from **external execution connections** (running background coding agents and local/remote tools). All connection configs, credentials, and host resource limits live in private files under the formal data root and never enter Bot transcripts or source Git.

## 1. Model Connections & Credential Storage

- **Configuration files**:
  - `config/model-connections.json` (Schema v2): stores model connections, default `activeId`, editable `purposeDefaults`, per-connection `connectionPurposes`, and recommended external Codex `(model, effort)` pairs.
  - `config/model-credentials.json`: stores API keys and standalone subscription login credentials.
  - `config/runtime.env`: referenced explicitly by environment variable name for existing host credentials.
  - `config/model-usage.json` & `usage.sqlite`: store cached provider quota window snapshots and the per-request token usage ledger.
- **Supported model connection kinds**:
  - **Codex subscription (`kind: "codex"`)**: imports existing host login from `~/.codex/auth.json` (or `CODEX_HOME`) over `openai-codex-responses`.
  - **Grok subscription (`kind: "grok"`)**: imports existing host login from `~/.grok/auth.json` (or `GROK_HOME` / `GROK_AUTH_PATH`) and aligns wire version headers with the installed CLI.
  - **Generic API (`kind: "api"`)**: supports `deepseek`, `openai`, `anthropic`, `xai`, and any `openai-compatible` endpoint across `openai-completions`, `openai-responses`, and `anthropic-messages`.

## 2. Purpose-Based Model Routing Table

Different stages of a Bot's lifecycle have different latency, cost, and reasoning needs. Summon divides model usage into **3 explicit purposes** (`modelPurposes`):

| Purpose (`purpose`) | Runtime Stage | Default Strategy |
| --- | --- | --- |
| `fast_read` | Group fast-read triage (`quiet` / `main` routing & live activity text) | Low latency with reasoning disabled (`thinking_level: "off"`) to minimize background listening cost |
| `conversation` | Main room conversation & direct chat (planning, replying, steering) | Balanced reasoning and responsiveness (default `thinking_level: "high"`) |
| `pi_session` | Standalone background Pi execution sessions (deep analysis, multi-file work) | Stronger model and/or deeper reasoning (`high` / `max`) |

### Template Defaults & Override Precedence

Summon ships editable `purposeDefaults` templates for 5 provider categories (`deepseek`, `openai`, `codex`, `anthropic`, `grok`) and resolves each Bot's effective model in this order:

1. **Bot-level custom (`mode: "custom"`)**: specifies a primary connection, model ID, thinking level, and optional per-purpose overrides under `purposes.fast_read`, `purposes.conversation`, and `purposes.pi_session` (allowing cross-provider mixing—e.g. DeepSeek for fast-read and Codex for main chat/execution).
2. **Follow specific connection (`mode: "follow_connection"`)**: resolves all three purposes from that connection's `connectionPurposes` or its category's `purposeDefaults`.
3. **Follow instance default (`mode: "follow_default"`)**: follows the instance's active default connection `activeId` (default for pre-installed Bots and Group Leads).

> Running Pi sessions freeze their bound `connection_id`, `model_id`, protocol, and thinking level at creation. If the underlying connection type or protocol changes later, existing sessions fail explicitly with `403 model_binding_changed` rather than silently switching providers. Auth and quota faults are likewise surfaced faithfully without hidden fallbacks.

## 3. External Execution Connections & Built-in Connectors

Alongside embedded `pi` sessions, Bots can launch registered external execution connections via `open_session`, driven natively by the gateway on the host machine:

| Connector | Capabilities |
| --- | --- |
| **Codex (`codex`)** | Built-in `codex app-server` protocol connector preserving native threads/turns, live `steer`, streaming output, history reads, and approval replies. Editable `(model, effort)` recommendations live in `externalEngines.codex.recommended`. Defaults to `sandbox: "danger-full-access"` and `approval_policy: "never"` (overridable per session or in connection settings). See [Codex connector notes](../capabilities/connectors/codex.md). |
| **Grok Build (`grok-build`)** | Drives local `grok` headless execution with structured streaming output and `--resume` continuation. See [Grok Build connector notes](../capabilities/connectors/grok.md). |
| **Claude Code (`claude-code`)** | Drives local `claude --print` streaming execution and `--resume` continuation. See [Claude Code connector notes](../capabilities/connectors/claude.md). |
| **Local CLI (`cli`)** | Any local executable or custom Node adapter script, supporting read-only probes (`--version` / `--help`), registered methods, and process-level `send_input` / `stop_session`. |
| **SSH (`ssh`)** | Controlled remote command execution over SSH (`capabilities/services/ssh-binding.mjs`). |
| **MCP (`mcp`)** | Official MCP stdio and Streamable HTTP transports with automatic tool discovery and invocation. |
| **HTTP (`http`)** | Direct REST / HTTP endpoint and method registration without wrapping in MCP. |

## 4. Onboarding, Out-of-Band Self-Repair & Usage Limits

- **Self-service onboarding**: The host user can start a private setup conversation via Web settings or `POST /api/connections/initialize`. Authorized Bots (especially **Interface Bot**) use `initialize_execution` to discover/inspect local tools, register connections and methods, and assign a dedicated `catalog-maintainer` Bot.
- **Silent out-of-band repair loop**: When any Bot encounters a verified execution fault (such as a CLI upgrade breaking flags), it sends a repair message to `{ kind: "connection", id }` with shareable call references. The assigned `catalog-maintainer` Bot diagnoses and repairs the connection in the background and replies with `reply_to` (`repaired`, `blocked`, or `need_info`) so the originating work resumes cleanly without cluttering the room.
- **Concurrency & token accounting**: Web settings expose concurrency limits, queue caps, and host resource limits. The Token Usage dashboard aggregates real requests by date, Bot, direct/group chat, source, purpose, and model alongside provider quota windows.
