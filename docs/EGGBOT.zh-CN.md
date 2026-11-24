[English](EGGBOT.md) | [简体中文](EGGBOT.zh-CN.md)

# EggBot 与内置角色

Summon Bot 不要求用户在开局前手写复杂的角色配置表。平台内置 5 种核心角色（定义于 `roles/index.mjs`），由默认常驻的 **EggBot**、**接口 Bot** 以及建群时自动生成的 **群主控** 协同完成日常对话主持、工具接入维护与按需团队孵化。

## 1. 五种内置角色

| `role_id` | 显示名称 | 职责与默认行为 |
| --- | --- | --- |
| `default` | 普通成员 | 通用协作伙伴。简洁推进分配到的任务并在拿到结论后统一汇报；需要宿主选择或确认时使用 `send` 的 `prompt` 选择框。 |
| `group-lead` | 群主控（群聊主持） | 每个普通群聊创建时同步生成（ID 为 `bot-lead-<roomId>`）。默认承接本群常规需求、未 `@` 指定他人的消息与选择框作答，拆解推进任务并做好收口；群内已有专责成员承接时不抢活。 |
| `eggbot` | EggBot（团队孵化） | 团队孵化与协作改善伙伴。默认退居幕后观察群内分工与缺口，不抢答常规需求；仅在被 `@` 点名、直接追问、发现长期职责缺口或周期观察发现明显卡点/遗漏时介入。 |
| `tool-onboarding` | 接口 Bot | 总接口 Bot。帮助查询、复用、接入本机 CLI / MCP / HTTP / SSH / 外部编码器连接并协调维修；支持在维护群（`room-default-bot-maintenance`）按日程复盘工具调用统计。 |
| `catalog-maintainer` | 连接维护者 | 绑定到具体执行连接的专责维护 Bot。收到 `connection.repair.request` 或探测失配时，核查版本、帮助、方法与脚本，按授权修复并实调验证后用 `send(..., reply_to)` 回报原连接事件。 |

> 说明：普通专责成员（如关卡策划、前端视觉、运维专员、测试工程师等）由 EggBot 或用户通过 `create_bot` 动态创建，填写清晰的 `public_duty` 与私有 `instructions`，无需新增硬编码内置角色。

## 2. 预置 Bot 与自动入群机制

- **实例启动预置**：Summon 启动时自动创建或复用两个全局预置 Bot：
  - `bot-default-eggbot-local`（EggBot）
  - `bot-default-tool-onboarding-local`（接口 Bot）
  已有预置 Bot 保留用户调整过的模型、指令和启停状态；新建预置 Bot 默认采用 `model: { mode: "follow_default" }`，跟随实例默认模型配置。
- **建群自动编队**：通过 `create_room` 创建普通群聊（`mode: "group"`）时，平台自动同步创建该群专属的 **群主控**（`group-lead`），并将启用的 **EggBot** 与 **接口 Bot** 一并加入群成员，同时可绑定一个可写项目工作区。已有群聊仍以实际成员列表为准。

## 3. EggBot 的观察、复用与孵化流程

1. **静默旁听与实时补位**：
   - EggBot 与群内其他成员一样默认正常听群（`mode: "all"`），常规群消息首先进入快读层；当群主控或现有专责成员运转顺畅时，EggBot 直接判 `quiet` 保持安静。
   - 一旦群内出现分工讨论、职责缺口或明显协作卡点，EggBot 会随时判 `main` 介入，无需等待被 `@` 或攒满固定条数。
2. **先查全团队再决定复用或新建**：
   - 调用 `find(kind: "bot")` 按名称或 `public_duty` 搜索全团队已有成员（加 `scope: { kind: "room", id }` 则只列本群成员）。
   - 若团队中已有合适专员，直接调用 `configure_room`（带当前房间 `revision`）邀请其入群，避免重复造轮子。
3. **孵化新专责成员并清晰交接**：
   - 当确需长期独立负责某领域时，调用 `create_bot` 写清名称、`public_duty`（供团队目录检索）、私有 `instructions` 与获准模型，再用 `configure_room` 拉入群中，并通过 `send` 简明交接目标、输入来源与交付位置。
   - 如需创建某个执行连接的专属维护 Bot，可同时传入 `role_id: "catalog-maintainer"`、`role_connection_id` 与来自 `read` 的 `connection_revision`，原子完成维护权限与工作区绑定。

## 4. Bot 角色与指令配置

- `instructions` 保存用户自定义长期指令，`public_duty` 保存公开职责摘要（最多 600 字符），`role_id` 指定内置角色。运行时系统提示词会将内置角色说明与个人指令分层组装。
- 可通过 `configure_bot` 或 `PATCH /api/bots/{id}` 携带当前 `revision` 单独修改任一字段；将 `role_id` 设为 `null` 可清除内置角色。
- 私有 Pi Session 保留开启时的角色、指令与模型绑定；共享 Pi Session 使用自身显式声明的输入与资源授权。
- 关于工具接入与维护协议细节，参见 [执行连接接入手册](../skills/summon-execution-onboarding/SKILL.md) 与 [模型路由与执行连接](MODEL_CONNECTIONS.zh-CN.md)。
