[English](EGGBOT.md) | [简体中文](EGGBOT.zh-CN.md)

# EggBot & Built-in Roles

Summon Bot does not require writing complex role matrices before starting a project. The platform ships with **5 core built-in roles** (defined in `roles/index.mjs`), pairing pre-installed **EggBot** and **Tool Onboarding Bot** with a per-group **Group Lead Bot** created automatically for every new group chat.

## 1. The Five Built-in Roles

| `role_id` | Display Name | Responsibility & Default Behavior |
| --- | --- | --- |
| `default` | General Member | General-purpose collaborator. Drives assigned work concisely and reports verified conclusions; uses `send.prompt` cards whenever host choices or confirmations are needed. |
| `group-lead` | Group Lead | Created synchronously for every regular group room (`bot-lead-<roomId>`). Hosts the room conversation by default, handles general requests, untagged messages, and prompt card replies, breaks down tasks, and closes the loop without stepping on specialists already handling a topic. |
| `eggbot` | EggBot (Team Incubator) | Team formation and workflow improvement partner. Stays quietly in the background by default so Group Lead drives daily chat; intervenes when `@mentioned`, directly asked, or when it spots a clear long-term ownership gap or stalled handoff. |
| `tool-onboarding` | Interface / Tool Bot | Central interface Bot. Helps look up, reuse, onboard, and coordinate repair for local CLIs, MCP servers, HTTP APIs, SSH endpoints, and external coding agents; supports scheduled usage reviews in `room-default-bot-maintenance`. |
| `catalog-maintainer` | Connection Maintainer | Dedicated maintainer bound to a specific execution connection. Handles `connection.repair.request` events and probe mismatches, diagnoses versions/help/methods/scripts, repairs and re-verifies in place, and replies to the connection event with `send(..., reply_to)`. |

> Note: Domain specialists (such as Level Designer, UI Designer, Ops Specialist, QA Engineer, etc.) are spawned dynamically by EggBot or the user via `create_bot` with clear `public_duty` and private `instructions`—no hardcoded role entries are needed.

## 2. Default Bots & Automatic Group Provisioning

- **Pre-installed global Bots**: On startup, Summon creates or reuses two global built-in Bots:
  - `bot-default-eggbot-local` (EggBot)
  - `bot-default-tool-onboarding-local` (Interface / Tool Bot)
  Existing configurations retain user-customized models, instructions, and enabled states; newly created default Bots use `model: { mode: "follow_default" }`.
- **Automatic group team setup**: When creating a regular group (`mode: "group"`) via `create_room`, the platform synchronously creates that room's dedicated **Group Lead** (`group-lead`) and automatically adds enabled **EggBot** and **Interface Bot**, optionally binding a writable project workspace. Existing rooms follow their actual member list.

## 3. How EggBot Observes, Reuses & Spawns Specialists

1. **Quiet listening & periodic observation**:
   - Regular room messages pass through Fast-Read first. When Group Lead and existing specialists are making smooth progress, EggBot stays `quiet`.
   - Each room's `room_base` wakeup defaults to triggering an EggBot observation check every `message_count = 20` new messages (configurable via `set_wakeup`) to catch multi-turn ownership gaps or bottlenecks.
2. **Search team directory before spawning**:
   - EggBot calls `find(kind: "bot")` to search existing team members by name or `public_duty` (adding `scope: { kind: "room", id }` lists only current room members).
   - If a suitable specialist already exists, EggBot invites them into the room via `configure_room` (with the current room `revision`) instead of creating duplicates.
3. **Spawn & hand off cleanly**:
   - When a genuine long-term independent ownership gap exists, EggBot calls `create_bot` with a clear name, `public_duty`, private `instructions`, and authorized model, invites the new Bot via `configure_room`, and posts a concise handoff via `send`.
   - For a dedicated execution connection maintainer, `create_bot` accepts `role_id: "catalog-maintainer"`, `role_connection_id`, and `connection_revision` (from `read`) to bind maintenance and workspace authority atomically.

## 4. Configuring Bot Roles & Instructions

- `instructions` stores long-term private user instructions, `public_duty` stores the public directory summary (up to 600 chars), and `role_id` selects the built-in role. The runtime layers built-in role instructions and personal instructions cleanly.
- Update any field individually via `configure_bot` or `PATCH /api/bots/{id}` using the Bot's current `revision`. Setting `role_id: null` clears the built-in role.
- Private Pi sessions preserve the role, instructions, and model binding captured at launch; shared Pi sessions follow their explicit input and resource grants.
- See also: [Execution Onboarding Skill](../skills/summon-execution-onboarding/SKILL.md) and [Model Routing & Execution Connections](MODEL_CONNECTIONS.md).
