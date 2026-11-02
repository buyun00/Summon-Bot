# Bot 3+3：第二版实现落点

更新：2026-11-02。本文件记录当前源码的连接方式，不是尚待逐条批准的计划，也不表示生产中已自然观察所有行为。正式构建、安装和启动由同次交付完成并单独如实说明。

| 能力 | 主要源码 | 当前连接 |
| --- | --- | --- |
| 身份、S1 与 S3 | `bot/src/storage/store.mjs`、`bot/src/runtime/works.mjs` | 消息按来源 ID 去重；work、conversation、task、run 分开；S3 保存目标、要求、来源、等待与绑定 |
| 多工作执行 | `bot/src/runtime/scheduler.mjs`、`runtime/bot.mjs`、`agent/engine.mjs` | 同会话串行、业务默认 4 位、前台优先；每个活动执行独立 Agent；持久等待释放位置 |
| Markdown 与维护 | `bot/src/context/maintenance.mjs` | 每次 organize/assemble/compact 创建短暂模型对话；MD 是正文，SQLite 仅目录与游标；失败保留增量 |
| 原文与恢复 | `bot/src/context/context.mjs`、`recovery.mjs` | 原始消息与投影分开，保留工具关联、历史读取及新增尾部；重组不重放已执行工具 |
| Skill | `context/resources.mjs`、`maintenance.mjs` | 自有 Skill 优先发现、目录检索、正文按需读取、串行写入与修订；整理结果可实际写入可复用方法 |
| 工作工具与通知 | `bot/src/capabilities/core-tools.mjs`、`runtime/bot.mjs` | works_list/work_*、持久等待、来源通知；当前纠正进入原 work |
| Codex 桌面外部执行 | `capabilities/codex/desktop.mjs`、`connectors/codex-desktop-api` | 稳定操作键、原线程续发、未知操作查询、SSE/快照恢复、结果持久回到原 work |
| 群聊与协作 | `capabilities/chatroom/service.mjs` | S3 来源查归属、单成员语义路由、按工作增量、异步成功/异常回流、FYI/重复链静默 |
| 持续职责 | `capabilities/bot-management/routines.mjs`、`service.mjs`、`gateway/index.mjs` | 沿现有 timer 调度；职责去重、在途合并、前台优先、状态 watch 无变化不唤醒 |
| 交付 | `scripts/installation/install.mjs`、`current-version.mjs` | 正式安装更新引用、选定当前发行、保留业务资料并移除被替代版本 |

## 从请求到持续工作

消息先入 S1，再按确定的 conversationId/workId 入队。聊天模型通过 works_list 查已有责任，用 work_create 建立新的持续委托或 work_dispatch 续接原工作。临时任务不再克隆 Bot。S3 的 sources 保留原 task、消息、房间和回复指针，跨群与私聊可以找到同一工作。

work_wait 保存同伴 taskId、时间或外部事件条件；当前执行结束后释放位置。真实结果通过持久事件进入原工作，成功、失败、取消、中断和未知状态分别保留。通知先落盘再发送，未知投递沿同一通知 ID 重试。暂停/取消只保留迟到事件，不自动改变停止意图。

## 从 S1 到 MD，再到本次输入

维护范围为 `work:<workId>` 或独立 `conversation:<conversationId>`。每范围有独立 MD、来源 session 列表、处理游标与 pending 状态。原始消息索引为来源定位，不是总结条目 ID。

任务产生有意义增量后，后台合并同范围的待整理请求。整理对话读取必要旧 MD 与原文，返回整份 Markdown 或无变化，并可返回基于真实证据的 Skill 更新。MD/Skill 保存成功后才前移该批游标；生成时的新消息仍待处理，失败状态也持久保留。

需要组装时另开短暂对话。它按相关目录补读材料，仅返回临时输入，不把输出保存为另一知识库。当前原始尾部和新指令由业务执行直接带入。预算不足触发独立 compact 对话并更新投影边界，S1、workId、外部绑定不变。

## 群聊投递与持续职责

聊天室按明确目标、提及、replyTo 和 S3 来源判定可直接定位的接收者。多成员群没有明确归属时，只投递一个 routeOnly 只读任务，解析实际成员和已知工作 JSON 后再把原始消息送负责者。路由失败保留消息与失败状态，没有全员唤醒兜底。

投递包在发出前冻结保存；接收 Bot 持久受理后才前移该范围的投递游标，未知或失败发送不前移，也不换消息 ID。已保存的 Bot 原文仍可供失败后恢复。群消息不是用户授权的替代来源；actor、原始 trigger 和 sourceRefs 保持可查。

routines_create 可用稳定 id/eventKey 更新职责。原 timer 调用 tickRoutines，同职责已有在途项时只合并；前台忙时延后。watch 只读比较 work/task/room 的真实观察，未变不进入模型。对没有 watch 的明确周期业务职责，定时事件本身仍按授权周期交给模型判断，不假装程序理解任意外部业务来源。

## 已退出的当前业务路径

- 普通工作使用 work，不使用 bots_clone/bots_deliver/bots_recycle 及父子记忆合并主链。历史关系和已交付材料仍保留。
- 新 Codex 工作不使用 codex_submit/app-server，不在桌面连接器失败时换后端重做。
- 常规总结不再维护 Pi 自动摘要与 MD 两份互相竞争的正文。旧检查点作为历史材料可读。
- 不再使用单个共享 Agent 同时承载多个工作，也不使用固定 30 条群背景、总 hop/讨论轮数截止防循环。

## 已知实现边界

语义归属、总结取舍和可复用方法仍依赖实际模型；路由与维护解析失败保留来源和待处理位置，不声称判断必然正确。token 预算采用估算，过大的真实输入可明确保留为待处理。连接器审批、登录和不可用私有工具仍受实际接口限制；没有凭据和入口不能从语义推断出来。

本轮不运行测试、模型探针、生产填充消息、哈希或完整性流程。构建和安装不以补齐历史验收记录为前提。后续真实使用出现具体错误时处理该错误，不扩展成额外验收平台。
