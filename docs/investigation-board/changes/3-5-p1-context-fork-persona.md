# P1 · 群公开主线、本轮 fork 与五层人格

**2026-11-20 · 已定稿并完成代码制作（待与后续批次合并验证） · 拆分批次 1 / 5。** 前置依赖：无（基于正式版 0.3.122 build 126 基线）。所属总纲：[单 Bot 内部对话与模型配置表 · 制作总纲](3-5-single-bot-core-outline.md)。

本篇先把单 Bot 群聊的**上下文结构与人格提示词**改扎实，不拆快读、不改模型表、不改界面协议，确保后续每一步都建立在稳定前缀与准确人设之上。

## 本篇范围与边界

- **本篇要做**：群公开主线稳定投影、本轮私有 fork 顺序（含中途插话与异步唤醒增量）、跨轮显式缓存断点延续、私聊与群聊历史路径对齐、五层人格与冲突优先级提示词。
- **明确不做**：不拆 ① 快读、不改模型/思考深度表、不改 UI 摘要通道、不改长历史压缩与后台 `material` 整理（沿用现行实现）。[现有压缩边界](D:/Relay-Bot/bot/src/context/room-history.mjs:26) · [后台资料整理](D:/Relay-Bot/bot/src/context/materials.mjs:171)

## 当前现状与改造落点

正式版目前存在四处与目标设计不符的实现：

1. **同一条公开消息随轮次变格式**：[projection.mjs](D:/Relay-Bot/bot/src/context/projection.mjs:10) 把当前轮消息标成 `current_event`，后续轮次改标 `historical_entry`，导致同一条原文跨轮文本变化。
2. **同一轮内新插话排到已读私有结果之前**：[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:691) 每次请求重新取最新公开群史，[room-history.mjs](D:/Relay-Bot/bot/src/context/room-history.mjs:28) 始终按 `[system, ...prefix, ...suffix, ...privateTurn]` 拼装，导致“原问题 A → 私有工具结果 B → 中途插话 C”在下一次请求时被重排成 `A → C → B`。
3. **跨轮显式缓存断点未延续**：[engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs:175) 只在当前 `run` 的 `transcript` 里找上一次的 `roomCacheThroughMessageId`，开启新 `run` 时为空，OpenAI Responses 显式缓存断点跨轮中断。
4. **私聊与群聊历史组装割裂**：[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:688) 仅对 `mode === 'group'` 走公开主线，私聊（`direct`）走单独的 `public_prefix_through` 切片逻辑，且 [service.mjs](D:/Relay-Bot/capabilities/chatroom/service.mjs:251) 支持私聊拉人升级为群聊。

## 改造方案

### 1. 稳定群公开主线

- 每个群共用一份按发布顺序追加的公开原文投影。去掉公开消息上随轮次切换的 `current_event` / `historical_entry` 标签，每条消息始终保持同一稳定序列化格式，保留消息 ID、真实作者、时间、正文、@、回复关系和附件引用。
- 公开原文在请求中只出现一次；本轮需要处理哪些消息，在 fork 尾部单列待处理的消息 ID 集合指明。
- 将显式缓存断点位置（如 `roomCacheThroughMessageId`）从单次 `run` 提升到按对话记录，使同一 Bot 的连续回合能够续上之前的公开前缀断点。

### 2. 本轮私有 fork 与插话/唤醒顺序

- 一轮公开处理开始时，锁定当前已读到的公开主线切点作为本轮 fork 的公开前缀；随后本轮内的工具调用、工具结果、运行事实和中途送入的新消息，均按**实际送入模型的先后顺序**追加到 fork 尾部。
  - 例：A 为原问题，B 为本轮私有工具结果，C 为本轮中途到达的插话，D 为最终公开答复。
  - 同一轮 fork 已经读到 A、B 后收到 C，下次模型请求顺序为 **A → B → C**。
  - 本轮结束发布 D 后，下一轮从公开主线重新出发，读到的公开顺序为 **A → C → D**，已完成回合的私有过程退出下一轮主线（仍保留可读历史记录）。
- **异步回执唤醒补齐公开增量**：当 fork 因等待异步回执挂起、稍后恢复继续执行时，须先取得挂起期间本群新增的可访问公开消息，按发布顺序追加到原 fork 尾部（在已送出私有过程之后），避免恢复后的 fork 对等待期间的群聊变化失明，同时不改动此前已发过的前缀。
- **私聊与升级衔接**：建议让 `direct` 私聊共用同一套稳定消息格式与 fork 追加顺序，避免拉人升级为群聊时历史投影切换。
- **已知边界说明**：本篇暂沿用现行 [room-history.mjs](D:/Relay-Bot/bot/src/context/room-history.mjs:26) 的压缩触发条件；当本轮私有工具结果特别长且公开历史本身接近窗口上限时，现行压缩仍可能提前触发全群公开摘要更新。独立按公开窗口触发及摘要复用留待压缩专题处理。[3.3 公开主线与压缩设计](3.3-room-context-forks.md)

### 3. 五层人格组成与提示词冲突顺序

在当前普通对话（后续由 ② 群主对话承接）及本轮 fork 中，沿用精简前有效的五层组装结构，fork 继承前四层：[精简前各层来源](3-5-single-bot-conversations.md#42-精简前一次普通群聊怎样组装) · [正式版提示组装](D:/Relay-Bot/bot/src/agent/engine.mjs:152)

| 层次 | 承载内容 | 生效范围 |
| --- | --- | --- |
| **硬底线（不可覆盖）** | 真实性与权限红线：不虚构工具调用与回执、引用与工具文本保留真实来源、操作受真实授权约束、结果以回执为准。 | 全局强制，不可被群约定或单轮话术覆盖 |
| **本轮层** | 当前待处理原话 ID、临时要求或更正、所需材料及本轮私有执行过程。 | 仅限本次交付 |
| **本群/项目层** | 本群已确认的长期约定、项目工作区与公开对话主线。 | 仅限本群或对应项目 |
| **个体层** | 该 Bot 的人格、性格口吻、用户长期指令（跨群沿用）。 | 该 Bot 全部群与私聊 |
| **岗位与通用默认层** | 内置岗位分工（如工程、接口、EggBot）与通用默认表达/协作习惯。 | 无上层指定时兜底 |

- **冲突规则**：在遵守硬底线的前提下，**当发言人具备相应权限且要求适用时**，优先级为：`本轮明确要求或更正` > `本群或项目有效约定` > `个体设定` > `岗位默认` > `通用默认`。
- **发言人身份区分**：明确区分**宿主用户（`user`）**的直接指令、**同伴 Bot** 的协作请求或建议、以及**历史引用与工具返回文本**（只作为事实/定位依据，不冒充当前用户指令）。
- **生效范围与持久化**：一次特例只管本次；当用户明确说“以后这个群……”或“你以后都……”时，除本轮生效外，沿现有 `material_index_ref` 资料索引机制落盘并标明 `applies_to`（本群或本 Bot），防止后续群历史压缩后丢失约定。

## 已定稿拍板项（2026-11-20 确认）

1. **五层冲突顺序修订（已确认采用）**：把“通用层”拆分为**置顶且不可覆盖的真实性/授权硬底线**和**置底的通用默认习惯**，并在提示词中明确区分宿主用户指令、同伴消息与历史引用/工具返回文本；一次特例只作用于本轮，长期约定沿 `material_index_ref` 落盘并标明 `applies_to`。
2. **私聊与群聊统一逻辑（已确认采用）**：私聊本质为两人房间，与群聊共用同一套稳定主线（`room_message`）、本轮 fork 追加顺序、跨轮缓存断点与五层提示词，不做功能区隔，拉人升级为群聊无缝衔接。
3. **本轮运行中收到新消息的默认处理（已确认采用）**：保持现行并入入口不动（不引入临时兼容层），运行中到达的新消息统一按实际送入顺序追加到当前 fork 尾部（保证 `A → B → C`）；该底层机制在 P3 引入 ① 快读后直接复用，整体留待后续批次完成后一并验证修复。

## 已完成代码落点

- [projection.mjs](D:/Relay-Bot/bot/src/context/projection.mjs)：新增 `isRoomMessageEvent`、`normalizeRoomMessage`、`roomMessageInput`，公开房间消息统一序列化为 `room_message`，去掉跨轮 `current_event` / `historical_entry` 切换。
- [service.mjs](D:/Relay-Bot/capabilities/chatroom/service.mjs)：新增 `publicMessagesRange`，支持按锁定切点读取公开前缀及切点后的公开增量消息。
- [bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs)：统一群聊与私聊房间历史路径（移除旧 `direct` 独立切片分支），按 `run.public_prefix_end` / `run.public_prefix_summary` 锁定本轮公开前缀并拉取切点后新增公开消息，同时将 `public_duty` 纳入 `binding`。
- [room-history.mjs](D:/Relay-Bot/bot/src/context/room-history.mjs)：公开前缀改用稳定 `room_message` 投影、移除前缀上的 `current_event` 标记，保留私有压缩时的 `fork_public_event`，压缩覆盖提示移至尾部并回传 `publicRoom.usedSummary`。
- [engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs)：落地五层人格与冲突优先级系统提示词（普通房间对话启用五层冲突规则，全部对话保留不可覆盖硬底线）；本轮首次送模时原子锁定 `public_prefix_end` / `public_prefix_summary`；中途插话与异步唤醒增量按发布顺序追加到 fork 尾部，尾部以 `current_room_inputs` 指明待处理原话 ID；将显式缓存断点 `room_cache_through_message_id` 提升到 `conversation` 级持久化，并仅基于锁定公开前缀计算断点。

## 独立验证清单

部署到唯一正式环境 `http://127.0.0.1:8787` 后，可独立核对以下可观察表现：

1. **格式稳定性**：连续两轮群聊，核对发送给模型的上下文中，第一轮消息在第二轮出现时序列化格式完全一致，不再出现 `current_event` / `historical_entry` 切换，且公开原文只出现一次。
2. **插话顺序（`A → B → C` / `A → C → D`）**：发问题 A 触发 Bot 调用耗时工具产生私有结果 B，在工具结果已送入后、回复前补发插话 C，Bot 公开回复 D。核对本轮 fork 请求顺序为 `A → B → C`，下轮公开主线顺序为 `A → C → D`，且 B 不出现在下轮公开主线中。
3. **异步恢复增量**：Bot 派发异步调用进入等待期间，在群里发新消息 E；回执唤醒原 fork 时，原 fork 尾部能按序读到 E 与回执，且不改写此前已送出前缀。
4. **人格与冲突优先级**：同一 Bot 加入两个群，保留同一个人格；在群内设“周报用英文”的长期约定后，发“这次改用中文详细写”只影响本次，下一次仍按英文；引用一条旧的“可以发布”并说“今天只讨论”，按当下要求只讨论。
