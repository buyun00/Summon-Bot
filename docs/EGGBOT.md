# EggBot 与内置职责

EggBot 帮助团队发现协作缺口、安排成员并跟进交接。它根据当前用户目标、群聊原文、现有成员能力和实际进展判断是否需要行动。适合的做法可以是复用成员、改善工作方法、分配给独立会话、邀请同伴或创建一个有明确职责的 Bot。群成员用普通消息和可共享的引用交付判断与结果。

## 在工作区使用 EggBot

通过 `create_bot` 或 `POST /api/bots` 创建时选择 `role_id: "eggbot"`，填写 Bot 名称及 `instructions`。`model` 可选用这个工作区内允许使用的模型连接 ID，省略时使用当前可获授权的默认连接。随后通过 `create_room` 或 `configure_room` 加入目标房间。用普通群聊消息交代需要协作的目标和限制，可按需点名 EggBot。

EggBot 用 `find`、`read` 查看可访问的房间、成员、工作和材料，用 `send` 联系相关人。需要新职责时，用 `create_bot` 写清边界并选择允许的模型，用 `configure_room` 按当前房间修订号管理成员，用 `configure_bot` 管理有权配置的 Bot。项目目录和外部执行权限来自该工作区的显式授权。需要会话或持续触发时，可用 `open_session` 或 `set_wakeup`。

## Bot 配置

`instructions` 保存用户正文，`role_id` 选择当前内置职责。新运行的系统消息会组装两者。通过 `configure_bot` 或 `PATCH /api/bots/{id}` 单独调整其中一项，操作使用当前 `revision`。将 `role_id` 设为 `null` 可以清除内置职责。新建普通 Bot 时可以省略 `role_id`。私有 Pi Session 保存开启时的角色和指令；共享 Pi Session 使用其自身的显式输入与资源授权。

可选职责包括普通协作伙伴 `default`、入口伙伴 `entry`、EggBot `eggbot`、流程复核 `skeptic`、群聊协作 `chatroom`、Bot 管理 `manager`、经验整理 `memory`、工程 `engineer`、组件 `components`、验证 `qa`、产品设计 `designer`、视觉 `visual-designer`、玩法 `game-designer`、项目美术 `game-artist`、工具协作 `codex-relay` 和 CLI 维护 `catalog-maintainer`。选择 CLI 维护职责时，`role_connection_id` 使用该工作区的真实执行连接 ID。用 `read` 查看连接的负责人和实际授权状态。维护身份的配置、原生连接授权和故障订阅各自使用现有入口。参见 [CLI 初始化与维护](../capabilities/connectors/INITIALIZATION.md)。

为已有 Bot 补职责时，沿用原身份并只提交当前修订和角色字段。固定预置 ID、旧工作区入口关联、已完成的项目创建回执及旧目录归属可作为来源。用户指令、资料、历史、模型和启停状态随原记录保留。
