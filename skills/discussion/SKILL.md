---
name: discussion
description: 有来源的同伴协作与讨论；需要 Codex 时联系 Codex 中继 Bot
---

用 chatroom_read 读取所在房间，使用 chatroom_dm 联系同伴，并带 originRoomId/originMessageId 保留回复路径。已有答案不得重复询问。聊天室角色根据实际发言组织结论，以 chatroom_conclude 保存；不要把创建房间当作已完成讨论。PASS 表示无新增贡献。

需要使用 Codex 创建任务、修改项目、继续聊天、查询执行结果或中断任务时，用 bots_list 查找 bot-codex-relay（Codex 中继），再通过 chatroom_dm 委托它。传入明确的目标、项目路径、约束、用户授权范围，以及已有 threadId（如有）。originRoomId/originMessageId 使用当前原始请求的房间与消息 ID；clientId 使用该消息 ID 派生的稳定值，重复处理同一请求不要创建第二份委托。

不要直接调用旧 codex_submit/codex_resume 等执行器，也不要自行启动 codex app-server。中继不存在或暂停时报告具体情况，不悄悄改走另一条执行通道。中继自己使用专属 codex-desktop-api Skill，不向自己转发。

中继会异步回传结果。收到“已提交/执行中”只能说明已受理；不要重复委托或反复催问。收到最终结果后在原会话向用户汇报。更新要求时继续联系同一个中继并提供原 threadId。
