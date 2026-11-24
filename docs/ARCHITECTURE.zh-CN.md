[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

# 系统总体架构

Summon Bot 是本地自托管的多 Bot 群聊协作平台，采用单一正式数据根（`D:/Relay-Bot-data`）与统一运行时网关。Web 进程负责用户认证、网页静态资源、客户端发行查询与 API/SSE 转发；本机回环网关承载平台对象处理器、Bot 运行时（嵌入式 Pi Agent）及各类外部执行连接器。

## 1. 模块布局

| 模块 | 职责 |
| --- | --- |
| `capabilities/gateway` | 统一回环网关、`/api/*` 路由、SSE 推送流与 APNs 生产推送队列 |
| `capabilities/platform` | 协议 3（`X-Summon-Protocol: 3`）对象契约与处理器：Bot、Room、Event、File、Session、Conversation、Call、Wait、Wakeup、Connection、Workspace |
| `capabilities/chatroom` | 群聊成员、消息、引用、附件、置顶与共享记录库（`capabilities/chatroom/state.sqlite`） |
| `capabilities/bot-management` | Bot 创建、预置角色初始化、群主控同步创建、修订管理与启停控制 |
| `capabilities/models` | 模型连接目录、按用途路由表、凭据存储与供应商额度快照 |
| `capabilities/services` & `capabilities/connectors` | Codex App Server、Grok Build、Claude Code、本地 CLI、SSH、MCP、HTTP 的真实调用、进程管理与原生输入目标 |
| `bot/src` | `BotRuntime`、快读收件器（`FastReadRuntime`）、Pi 引擎、上下文投影与主线/Fork 管理、资料索引与 Token 账本（`usage.sqlite`） |
| `roles` & `skills` | 5 个内置角色说明（`roles/index.mjs`）与执行接入指南（`skills/summon-execution-onboarding/SKILL.md`） |
| `web`、`desktop`、`ios`、`android` | 普通网页（Paper / Midnight）、Electron 桌面外壳、SwiftUI iOS 26 原生客户端、Jetpack Compose Android 原生客户端 |
| `scripts` | 发行构建（`scripts/build`）、正式安装与看门狗（`scripts/installation`）、数据维护（`scripts/maintenance`）与四端发布（`scripts/release`） |

## 2. 聊干分离与三层运行机制

为避免群内无关 Bot 抢话刷屏以及重任务执行卡死聊天，每个群成员的运行拆分为三层：

1. **① 快读收件层（`FastReadRuntime`，用途 `fast_read`）**
   - 默认以关闭思考（`thinking_level: "off"`）、零写权限运行。
   - 批量读取新到的群公开消息，对每条消息做二元路由判断：`quiet`（与本 Bot 职责无关、无需介入时当场静默）或 `main`（需要介入时转交本群主对话，并产出 6–24 字的「正在…」实时进度文案，直接展示在输入框上方的状态栏中）。
   - 若因权限或解析异常无法完成快读，自动安全降级转交主对话，不丢消息。
2. **② 群主对话层（用途 `conversation`）**
   - **唯一公开发言口**：在群对话中，模型结束轮次时的最终纯文本仅作内部记录，不会展示给用户；公开发言必须显式调用 `send` 工具（支持 `reply_to`、附件、引用、`@mentions` 以及交互式选择/确认卡 `prompt`）。
   - 统一负责需求拆解、回复用户、向在途后台执行会话发送 `steer` / `next` / `reply`、接收异步回执并向原群简洁交付结果。
   - 当并发发言触发 `room_sequence_changed` 时，先阅读期间新消息再决定是否补充差量或保持静默，避免重复刷屏。
3. **③ 后台执行会话层（独立 Pi 会话 `pi_session` 与外部执行器）**
   - 主对话通过 `open_session` 启动独立 Pi 会话或 Codex、Grok Build、Claude Code、CLI、SSH、MCP、HTTP 等外部执行会话。
   - **平台硬门禁（`403 room_send_forbidden`）**：只有 Bot 的群主对话可以向房间公开发言；后台执行会话禁止直接向群内发送消息（仅允许向 `{ kind: "connection", id }` 发送已核实的连接报修事件），结果通过平台 `wait_ref` 异步回执交回直接父对话验收后再发群。
   - 主对话调用 `open_session` 并登记 `wait_ref` 后即可静默结束当前轮次，前台群聊保持 0 卡顿，可随时继续讨论其他议题或向在途任务发送纠正。

## 3. 平台工具契约（协议 3）

客户端 JSON 接口要求 `X-Summon-Protocol: 3`（SSE 流传递 `?protocol=3`），写入重试携带原 `clientId` 或 `X-Summon-Client-Id` 保证幂等。嵌入式 Pi 运行时通过 `platform.invoke` 使用 13 个核心工具，并在具备接入权限时附加 `initialize_execution`：

| 工具 | 作用 |
| --- | --- |
| `find` | 检索可访问对象（`bot`、`room`、`event`、`file`、`session`、`wakeup`、`connection`、`conversation`、`call`、`wait`、`workspace`）及 `connection_usage` 调用统计 |
| `read` | 读取对象详情、历史页、执行输出、可用输入目标、文件文本/历史修订/图片（支持视觉模型）或任意本机目录与文件 |
| `send` | 向房间公开发言（支持 `prompt` 交互式单选/多选/文本/权限确认卡），或向 `{ kind: "connection", id }` 发送/回复故障报修 |
| `save_file` | 写入或按修订更新平台 File、从共享附件复制，或向本机目录写入文本 |
| `create_bot` / `configure_bot` | 创建 Bot 或按修订更新名称、`public_duty`、指令、模型绑定、启停状态、`role_id`、维护连接绑定及 `material_index_ref` |
| `create_room` / `configure_room` | 创建群聊或私聊；按修订更新群名、成员、置顶或绑定的项目工作区 |
| `open_session` / `configure_session` | 启动独立 Pi 或外部执行会话（附 `work_summary` 实时展示）；更新会话摘要或等待说明 |
| `send_input` / `stop_session` | 向在途执行提交 `reply`、`steer` 或 `next`（按 `codex_turn`、`pi_run`、`cli_process`、`service_call`、`idle_input` 定位）；中断指定范围的在途运行并即时恢复可输入状态 |
| `set_wakeup` | 创建或更新群基础关注（`room_base`）、事件订阅（如 `work.tool`）、单次定时（`time`）或周期定时（`recurring_time`） |
| `initialize_execution` | 读取同版接入手册、发现/探测本机工具、查看脚本源码、注册或更新执行连接/方法、绑定专责维护 Bot |

## 4. 上下文主线、五层优先级与持久记忆

- **公开主线 + 本轮私有 Fork**：群公开消息按发布顺序以稳定格式进入所有成员的公开主线前缀，确保高 Prompt 缓存命中率；单轮工具调用、插话与异步唤醒附加在私有 Fork 尾部。上下文超窗时仅压缩公开主线与前序公开摘要，保留活跃约定、未完成工作引用与已交付成果。
- **五层指令优先级（服从不可覆盖的硬边界）**：
  1. 本轮明确请求或纠正（仅本次交付生效）
  2. 已确认的群或项目长期约定（仅本群/本项目生效）
  3. Bot 个人长期指令与人设（跨群生效）
  4. 内置角色默认说明（`roles/index.mjs`）
  5. 通用平台默认规则
- **长期经验与资料索引（`material_index_ref`）**：Bot 可在私有空间维护普通 JSON 索引文件并登记为 `material_index_ref`，条目记录稳定 `id`、`revision`、`applies_to`（适用房间或 Bot）、`note` / `material_ref` 与 `source_refs`（原始消息引用），确保长期习惯与群规在历史压缩后持续生效。
- **本机目录自治**：已登记的 `workspace` 作为群默认工作区与常用书签，而非目录牢笼；Bot 可直接传入本机绝对路径读取、写入或启动执行会话，仅平台自身运行/安装存储与宿主凭据文件受保护。

## 5. 数据存储与延伸阅读

- 房间、成员、消息与平台对象持久化在 `capabilities/chatroom/state.sqlite`；各 Bot 的收件箱、内部对话、执行记录与等待游标独立保存在 `bots/<id>/state.sqlite`；模型 Token 账本保存在 `usage.sqlite`。
- 相关文档：
  - [EggBot 与内置角色](EGGBOT.zh-CN.md)
  - [模型路由与执行连接](MODEL_CONNECTIONS.zh-CN.md)
  - [网页与 App 访问认证](WEB_AUTH.zh-CN.md)
  - [运行维护](OPERATIONS.zh-CN.md)
