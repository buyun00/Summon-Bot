---
name: discussion
description: 按工作关联的同伴协作、异步结果与有来源纠错
---

用 bots_list 发现同伴职责和已知责任，按用户意图选择一个合适承担者；不要以项目类别、文件夹名或岗位名称硬编码归属。已有明确 workId 或回复关联就继续原工作，多个合理候选无法区分时才最小澄清。

chatroom_read 按需读取原文，chatroom_dm 联系同伴时带 originRoomId/originMessageId、自身 workId 和稳定 clientId。targetWorkId 仅填对方已知的真实工作。携带目标、必要输入、允许与禁止的动作、来源授权和返回位置，不转发无关私聊。

普通最终回复自动回来源；不要重复 chatroom_send。投递回执不是答案，同伴成功、失败、取消和中断均会回流。需要等待用 work_wait 保存真实 taskId/同伴，不高频轮询，也不重新委托结果未知的动作。

purpose=request 表示需要行动，correction 提供具体来源和受影响工作，fyi 只记录不唤醒。纯致谢与重复确认不要继续发送。纠错核对 sourceRefs、原文和工具结果，更新相关 MD 并通知确实受影响的工作；没有新信息的互聊链结束，正常长任务保留。

需要 Codex 时优先查已有承担该能力的同伴及当前 codex-desktop-api Skill。新工作只走整合后的桌面连接器，保持原 work/操作键/threadId/turnId；不存在或暂停就保留具体缺口，不切回旧 app-server，不同时向两个后端提交。

讨论结论依据实际发言与证据，用 chatroom_conclude 保存。没有新增贡献时单独返回 PASS。不能替未回复者编造观点，不能以投票替代事实。
