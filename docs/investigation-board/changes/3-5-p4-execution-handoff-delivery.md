# P4 · 派工、回执与回原群交付

2026-11-20 定稿。群主对话②可以派出多个工作会话③。每个独立 Pi 也可以继续派工，并自行管理它直接创建的子会话。外部 Codex、CLI 等按各自的原生协议执行。[制作总纲](3-5-single-bot-core-outline.md)

## 谁负责哪条工作

派工时，父对话用 `open_session` 交代用户原话、目标、实际工作目录、适用限制、完成条件和可分享的材料引用。群对话用 `origin_message_id` 指定原提问，尤其是一次收到多条群消息时。`work_summary` 用一句话写明目标和完成条件。公开工具观察使用 `work_room` 与 `work_source`，私有派工也保存原提问归属。

会话记录保存直接派生关系 `origin_execution`、父对话与派工回合 `owner_conversation_id`、`owner_run_id`，以及 `origin_room`、`origin_message_id`、`work_summary` 和 `waiting_summary`。引擎可以跑完一个 turn 后等补充，业务验收状态 `acceptance_state` 仍为 `open`。子 Pi 派出的工作由该 Pi 收回执、核对成果，再向它的父对话报告。[执行平台](../../../capabilities/platform/platform.mjs) · [执行会话](../../../capabilities/platform/executions.mjs)

## 回执如何回到派工回合

已有对话的类型取自各 Bot 的本地对话记录。历史派工按已有调用和来源消息恢复父对话与原群归属。仍在等结果的工作保留开放状态，已结束且没有业务验收记录的历史会话保留原引擎结果，验收状态留空。

平台以调用编号和回执位置识别重复投递。新回执优先恢复仍可处理的派工回合。已结束回合的迟到结果会在同一父对话中启动验收回合，按原工作归组。期间新到的群聊能够另起回合。验收回合可以看见挂起期间的公开群消息，只有它自己的私有工具过程和相关工作的回执会进入这次验收。

同一个父对话围绕一条原提问派出多项工作时，`origin_work_status` 列出这些直接子会话的目标、引擎状态、等待摘要、最近调用、验收状态及已有交付消息。每条回执保留其当时的位置和可读取的引用。父对话据此区分已受理、需要输入、部分完成、失败、结果未知与已满足完成条件，自行决定何时报告进度。[收件箱](../../../bot/src/storage/inbox.mjs) · [回合调度](../../../bot/src/runtime/bot.mjs)

## 公开交付和收尾

成果达到用户的完成条件后，②用 `send` 发到 `origin_room`，以 `reply_to` 引用 `origin_message_id`，在 `completed_sessions` 中列出本次验收的工作。原消息引用、公开交付和对应会话结案属于一次事务。已结案的会话保留交付消息引用。迟到的实质更正可由②再次引用原提问说明。

父对话也可用 `configure_session` 更新任务或等待摘要、关闭已取消的工作，或按新的要求重新打开会话。真正中断正在执行的引擎使用 `stop_session`。

工作有结果时，如果 Bot 已离开原群或原群已删除，平台在会话上保存私有的 `pending_delivery`，包含原群、原提问、调用和回执引用。宿主可从会话详情读取该记录，原群恢复后可据此补发，或在处理后关闭。这里沿用现有会话查看入口。[工具契约](../../../capabilities/platform/contract.mjs) · [主对话与 Pi 指令](../../../bot/src/agent/engine.mjs)
