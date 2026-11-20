# P3 · ① 快读收件（静默 / 交主对话）、UI 摘要通道与 ② 唯一公开发言口

**2026-11-20 · 已定稿并完成代码实现（网页/桌面 + iOS + Android + 后端） · 拆分批次 3 / 5。** 前置依赖：P1（稳定公开主线投影）、P2（①② 各自的模型与思考档配置）。所属总纲：[单 Bot 内部对话与模型配置表 · 制作总纲](3-5-single-bot-core-outline.md)。

本篇完成“拆开收件判断与公开发言”的核心架构切换：让普通群消息先经每 Bot 每群的 ① 快读分流，产出 UI 摘要，并在**静默 `quiet` / 交主对话 `main`** 之间做决定；同时把公开发言口硬收拢到 ②。复杂的执行器直转 `forward` 与跨群续办留到 P5，确保先把快读骨架、准确率和界面体验跑稳。

## 本篇范围与边界

- **本篇要做**：每 Bot 每群的 ① 快读及其独立阅读位置、① 的 `quiet` / `main` 两项基础去向、UI 摘要通道（网页先做，桌面复用，定稿后同步 iOS/Android）、② 独占群公开发言口的程序层硬门禁、非群消息与 EggBot 的分流规则、崩溃一致交接与故障降级、运维与用量接入。
- **明确不做**：本篇暂不启用 `forward` 直转与快读间私下询问（留到 P5）；不做头像动画（表现层另议）；不做群主控兜底与同源自动接龙上限（工作项 5）。

## 当前现状与改造落点

1. **收件与发言混在一条 `room`**：[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:317) 把所有普通群投递直接送入 Bot × 群的唯一 `room` 会话，一轮同时承担读消息、静默、查资料、派工和 `send` 发言。
2. **公开发言口未按调用层硬拦截**：[engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs:44) 给独立 Pi 也注入全部 12 工具，[platform.mjs](D:/Relay-Bot/capabilities/platform/platform.mjs:1072) 只检房间写权，未禁止共享独立 Pi Session 直接向群 `send`。
3. **非聊天事件与 EggBot 观察共用 `room` 调度**：[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:278) 同时调度 `message`、`wakeup.time`、`call.receipt`、`work.tool`、`connection.failure` / `connection.repair.request`，且 EggBot 通过 [delivery.mjs](D:/Relay-Bot/capabilities/platform/delivery.mjs:49) 和 [room-observation.mjs](D:/Relay-Bot/bot/src/context/room-observation.mjs:20) 按 20 条消息批量回看并推进 `observation.through` 检查点。
4. **实时同步仅发无载荷事件**：[gateway/index.mjs](D:/Relay-Bot/capabilities/gateway/index.mjs:111) 的 SSE `/api/stream` 只推事件类型，四端通过 [sync.mjs](D:/Relay-Bot/capabilities/shared/sync.mjs:3) 增量同步房间状态。

## 改造方案

### 1. ① 快读与 ② 主对话的分工及存储形态

- **② 群主对话**：直接沿用现有 `kind: 'room'` 会话承接 ②，已有群史、人格、执行 ID 和未结等待无缝延续。② 负责这个 Bot 在本群的全部公开发言（包括简单回答、澄清、主动提醒和异步交付）。
- **① 快读阅读器**：每 Bot 每群新增独立阅读位置游标与快读状态（空闲时不占用模型）。
  - **无历史助手污染的投影**：① 每次请求由 `[稳定快读提示词（Bot 本群职责 + 路由规则 + 输出格式）, P1 稳定群公开主线, 尾部（本轮待判消息 ID）]` 组装。不把历史快读输出塞回公开前缀，保证 ① 拥有稳定可复用的公开主线 KV 缓存前缀，也不会因过期输出膨胀上下文。
  - **只读最小权限**：① 不注入任何写工具（`send`、`open_session`、`send_input`、`save_file`、`configure_*`、`set_wakeup` 等全部不可用），平台层同步拒绝来自 ① 的写调用。
  - **快读免认领登记**：各收件 Bot 并行独立判断，不引入抢占认领状态。
  - **提示词继承**：从既有实验最终版 `g20-c01` 中沿用判断接话对象、无 @ 追问、重复发言和纠错缺口的语义依据，去掉旧版允许快读直接发言/派工/写记忆/改头像的部分。[实验提示词对照](3-5-single-bot-conversations.md#20-轮实验的最终提示词能沿用什么)

### 2. 基础两去向（`quiet` / `main`）、连发消息与异常降级

| 字段 / 情况 | 规则 |
| --- | --- |
| `summary` | 将本条消息及理解它所需的前文压成一句本群可显示的简短摘要，**只写有依据的输入事实**（不写路由结果，避免误导）。两个去向均产出。 |
| `quiet` | 与本 Bot 无关、已有人答清、或纯收悉/复述。本 Bot 本次结束，原文留在公开主线，② 不被唤醒，下次运行自然读到。 |
| `main` | 需要公开回答、澄清、查证、新工作、改方向、停止已有工作或归属有歧义。宿主把带原作者、引用和附件的原话交给本群 ②。 |
| **连发消息合批** | 当短时间内多条群消息排队待判时，一次快读按批读取这些待判消息 ID，输出逐条或合并的路由决策，避免用户连发“给你看图”+`[图]`被拆碎误判。 |
| **故障与格式异常降级** | ① 关闭思考运行，若出现 JSON 解析失败、缺必填字段、模型超时或连接错误，**默认降级为 `main` 交 ② 接手**（绝不静默丢消息），同时记录诊断。 |

### 3. 原子交接与非群聊事件旁路

- **事务一致与 `delivery` 状态**：
  - ① 选 `quiet`：在同一事务中推进 ① 阅读位置、保存 UI 摘要，并将该消息 `delivery` 标为 `processed`。
  - ① 选 `main`：在同一事务中推进 ① 阅读位置、保存 UI 摘要，并将原消息路由写入 ② 的待处理队列；**在 ② 真正完成处理前，绝不提前将 `delivery` 标为 `processed`**，确保进程重启不丢消息，也为工作项 5 的只读监控保留真实在途状态。
- **非普通群消息直通 ② / 原等待 run（不过 ①）**：
  - `wakeup.time`（定时提醒）、`call.receipt`（异步调用回执）、`connection.failure` / `connection.repair.request`（连接故障与维修请求）、`file` 通知等事件直接进入 ② 或对应等待 run，避免被 ① 误判 `quiet` 吞掉，也不强行生成“关联原群消息”的摘要。
  - `work.tool` 订阅事件：默认直通 ②（无需面向用户再概括为聊天消息摘要）。
  - **EggBot 观察唤醒**：触发 `room_observation`（按 20 条消息批量回看并推进 `observation.through` 检查点）的唤醒走独立观察路径直通 ②，防止检查点卡死；EggBot 被普通 @/回复或参与常规讨论时按约定衔接。

### 4. ② 唯一公开发言口的程序层硬门禁

- 在 [platform.mjs](D:/Relay-Bot/capabilities/platform/platform.mjs:1072) 的 `send` 入口增加调用层校验：
  - 发送目标为 `{ kind: 'room' }` 时，仅允许宿主用户与该群的 **② 主对话**调用，拒绝来自 ① 快读或 ③ 独立 Pi Session 的群公开发言。
  - 发送目标为 `{ kind: 'connection' }`（连接故障报修与回复）不受此限制，沿用既有维修授权。
- 对 ③ 独立 Pi Session 的工具声明同步收敛或明确提示，使其通过回执向负责它的 ② 汇报，由 ② 统一决定公开发言。

### 5. UI 摘要通道与运维接入

- **独立展示通道与防回灌**：
  - 摘要按 `(room_id, message_id, bot_id)` 关联存储，通过现有增量同步（`/api/rooms/:id/messages?sync=1` 或配套摘要集合）与 SSE 事件名通知客户端刷新，**不生成群消息、不触发任何成员订阅、绝不进入群公开主线或任何 Bot（含自身 ②）的模型上下文**。
  - 保持与现有 `protocolVersion = 3` 兼容（纯增量可选字段），便于先在网页端制作和调试效果，定稿后再同步 iOS（SwiftUI）与 Android（Kotlin/Compose）。
- **运维与可观测接入**：
  - ① 的在途请求接入 [bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:1000) 的 `stopBot`、宿主模型并发/令牌额度、以及安装热更新排水 `drainStatus()`。
  - ① 不注册为面向 `/api/executions` 展示的普通执行会话，且短暂的快读运行不长期阻塞后台 `material` 整理（[materials.mjs](D:/Relay-Bot/bot/src/context/materials.mjs:184)）。
  - 所有 ① 调用在 `usage.sqlite` 中记录 `purpose: 'fast_read'`。

## 已定稿决策（2026-11-20）

1. **UI 摘要持久化与四端折叠展示**：按 `(room_id, message_id, bot_id)` 持久化在 `chatroom` SQLite（`kind = 'room-message-summaries'`），随 `/api/rooms/:id/messages` 可选字段 `summaries` 增量同步（兼容 `protocolVersion = 3`），通过 SSE `delivery` 通知客户端刷新。网页端/Electron 桌面端、原生 iOS（SwiftUI）与原生 Android（Kotlin/Compose）均已同步实现消息气泡下方的默认折叠紧凑条，点击展开查看各 Bot 摘要。摘要绝不写入 `messages`、公开主线或任何 Bot 的模型上下文。
2. **连发消息合批**：① 按 `(botId, roomId)` 串行批处理排队待判消息（单批最多 16 条），一次请求返回 `{"items":[{"message_id":"...","summary":"...","route":"quiet"|"main"}]}`（兼容单条回退结构）；短时间连发上下文连贯，且单条缺失或非法字段时自动按 fail-open 降级为 `main`。
3. **EggBot 与总接口 Bot 订阅边界**：EggBot 的 `first_user` 与 `message_count`（20 条）观察唤醒绕过 ① 直通 ②，防止 `observation.through` 卡死；EggBot 被普通 @/回复后若 ① 判 `quiet`，同步释放 `observation.pending` 并在已达阈值时补齐观察队列。总接口 Bot（`tool-onboarding`）在新普通群中保持 `mentions` 默认订阅。

## 代码实现落点

- **① 快读运行时与调度**：
  - [bot/src/runtime/fast-read.mjs](D:/Relay-Bot/bot/src/runtime/fast-read.mjs)：基于 `g20-c01` 蒸馏的只读快读提示词、P1 稳定公开主线投影与显式缓存断点、单批最多 16 条连发合批、严格 JSON 解析与 fail-open `main` 降级、原子提交（`quiet` 标记 `processed` 并消费投递；`main` 保留 `pending` 直至 ② 完成）、429 资源额度退避、`usage.sqlite` 记录 `purpose: 'fast_read'`。
  - [bot/src/storage/runtime-records.mjs](D:/Relay-Bot/bot/src/storage/runtime-records.mjs)：新增 `fastRead: 'fast-read'` 持久化游标记录类型。
  - [bot/src/runtime/bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs)：接入 `FastReadRuntime` 调度、防 `waiting` run 唤醒绕过 ①、`stopBot` / `drainStatus` / `close` 运维接入（不注册 `/api/executions`、不阻塞 `materials`）。
- **② 唯一公开发言口硬门禁 & ① 只读约束**：
  - [capabilities/platform/platform.mjs](D:/Relay-Bot/capabilities/platform/platform.mjs)：支持不注册执行的 `fast_read` 只读模型上下文校验；`executeTool` 拒绝来自 `fast_read` 的任何写工具（`403 fast_read_readonly`）；`write('send')` 仅允许宿主用户与 ② 主对话向 `{ kind: 'room' }` 发言，拒绝 ① 与 ③ 独立 Pi Session（`403 room_send_forbidden`），保留 `{ kind: 'connection' }` 报修链路。
  - [bot/src/agent/engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs)：对 ③ 独立 Pi Session 收敛 `send` 工具声明仅允许 `connection` 报修目标，并在系统提示中明确要求通过最终输出回执向 ② 汇报。
- **UI 摘要通道与四端展示**：
  - [capabilities/chatroom/service.mjs](D:/Relay-Bot/capabilities/chatroom/service.mjs)、[capabilities/gateway/api.mjs](D:/Relay-Bot/capabilities/gateway/api.mjs)：持久化 `room-message-summaries`、返回 `summaries` 并触发 SSE `delivery`。
  - [web/frontend/app.js](D:/Relay-Bot/web/frontend/app.js)、[web/frontend/cybercab.css](D:/Relay-Bot/web/frontend/cybercab.css)、[web/frontend/style.css](D:/Relay-Bot/web/frontend/style.css)：Web / Electron 桌面端默认折叠摘要条与展开卡片。
  - [ios/Summon/Models/SummonModels.swift](D:/Relay-Bot/ios/Summon/Models/SummonModels.swift)、[ios/Summon/Store/SummonStore.swift](D:/Relay-Bot/ios/Summon/Store/SummonStore.swift)、[ios/Summon/Views/ChatView.swift](D:/Relay-Bot/ios/Summon/Views/ChatView.swift)：iOS SwiftUI 模型、本地快照缓存与折叠摘要条。
  - [android/app/src/main/java/org/lin0/relay/Models.kt](D:/Relay-Bot/android/app/src/main/java/org/lin0/relay/Models.kt)、[android/app/src/main/java/org/lin0/relay/Store.kt](D:/Relay-Bot/android/app/src/main/java/org/lin0/relay/Store.kt)、[android/app/src/main/java/org/lin0/relay/ChatScreen.kt](D:/Relay-Bot/android/app/src/main/java/org/lin0/relay/ChatScreen.kt)：Android Kotlin/Compose 模型、本地快照缓存与折叠摘要条。

## 独立验证清单

部署到唯一正式环境 `http://127.0.0.1:8787` 后，可独立核对以下可观察表现：

1. **静默分流（`quiet`）**：在多 Bot 群发一条与某 Bot 无关或纯收悉的消息，该 Bot 的 ① 产出 UI 摘要并选 `quiet`，② 未被唤醒（`usage.sqlite` 只有 `fast_read`、无 `conversation` 记录），其他成员不被摘要唤醒。
2. **交主对话（`main`）**：发需要回答或查证的问题，① 产出摘要并选 `main`，② 唤醒并通过 `send` 公开发言；下轮 ② 能自然读到之前 `quiet` 的公开消息。
3. **异常降级与重启不丢消息**：模拟 ① 返回非法格式或临时失败时，消息降级交 ② 处理；核对 `main` 路径在 ② 完成前 `delivery` 未提前标记 `processed`。
4. **公开发言硬门禁**：验证独立 Pi（③）调用 `send(to: room)` 被平台层拒绝，而 `send(to: connection)` 报修链路正常。
5. **非聊天事件旁路**：触发一条定时提醒 `wakeup.time`、一次异步回执 `call.receipt` 和一次 EggBot 观察，确认均正常送达不被 ① 误吞。
6. **模型与用量核对**：在 `usage.sqlite` 中确认 `fast_read` 走 P2 表内 ① 行（`off`），`conversation` 走 ② 行（`high`），并记录网页端摘要视觉效果（定稿后同步 iOS/Android）。
