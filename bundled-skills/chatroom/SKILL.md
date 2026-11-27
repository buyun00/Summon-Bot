---
name: chatroom
description: 群聊发言、@点名、选择框与隐私输入窗
owner_bot: null
env_slots: []
---

# 群聊与消息能力（chatroom）

## 怎么用
- **Summon Bot**：通过 `send` 向所属群发言，支持 `reply_to`、`mentions`、`attachments`、`prompt`（`question` / `permission` / `confirm` / `secret`）。
- **工作引擎（AGY / Codex / Claude Code / Grok / exec）**：将最终结论与产出写入会话输出，由发起会话的 Summon Bot 审阅并同步到群聊。
