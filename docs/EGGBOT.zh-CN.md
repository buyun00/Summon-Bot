[English](EGGBOT.md) | [简体中文](EGGBOT.zh-CN.md)

# EggBot 与内置角色

Summon Bot 不要求用户在开局前手写复杂的角色配置表。平台内置 3 种核心角色（定义于 `capabilities/bot-management/roles.mjs`），由全平台常驻主控 **Summon**、团队孵化伙伴 **EggBot** 与按需创建的长期专职成员协同完成日常需求推进、重活委派与团队扩张。

## 1. 三种内置角色

| `role_id` | 显示名称 | 职责与默认行为 |
| --- | --- | --- |
| `group-lead` | 主控（Summon） | 全平台常驻主控，以分身形态入驻所有普通群聊与维护群（ID 为 `bot-lead-room-default-bot-maintenance`），跨群共享内部大脑与记忆。负责承接需求、区分调研（`inquiry`）与执行（`execute`）、把关方案、委派工作引擎与统筹收口；在系统维护群中还兼管工作引擎自检与桥接自愈。 |
| `eggbot` | EggBot（团队孵化） | 团队孵化与协作改善伙伴（`bot-default-eggbot-local`）。日常顺畅时静默旁听；被 `@`、讨论分工、需要衍生独立业务群或发现长期专业缺口时介入，优先复用老成员，确有长期专业空白时才招新。 |
| `default` | 专职成员 | 长期负责某专业领域的赛博员工，在各群的分身上下文彼此隔离防串台、内部记忆与工作会话互通；重活优先整包派给工作引擎（如 `agy` / `codex`），工位内审活后再向群内交付。 |

> 说明：工作引擎（`agy`、`codex`、`claude-code`、`grok-build`）由平台在 `D:/Relay-Bot-data/engines/` 统一提供，无需为其创建独立 Bot 成员。

## 2. 预置 Bot 与自动入群机制

- **实例启动预置**：Summon 启动时自动创建或复用全局主控 **Summon**（`bot-lead-room-default-bot-maintenance`）与 **EggBot**（`bot-default-eggbot-local`），均默认跟随实例默认模型配置。
- **建群自动编队**：通过 `create_room` 创建普通群聊（`mode: "group"`）时，默认自动入驻常驻主控 **Summon** 分身与 **EggBot**，可同时绑定项目工作区与指定专职成员。已有群聊仍以实际成员列表为准。

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
