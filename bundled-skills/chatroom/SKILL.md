---
name: chatroom
description: 群聊发言、@点名、选择框与隐私输入窗（当前仅接受群内宿主、Bot 与平台系统通知，暂无外部服务器入站 Webhook）
owner_bot: null
env_slots: []
---

# 群聊与消息能力（chatroom）

## 怎么用
- **Summon Bot**：通过 `send` 向所属群发言，支持 `reply_to`、`mentions`、`attachments`、`prompt`（`question` / `permission` / `confirm` / `secret`）。
- **工作引擎（Codex / Claude Code / Grok / exec）**：工作引擎不能直接向群聊发言；把结果作为本次会话最终输出返回，由发起会话的 Summon Bot 消化并交付给群聊。

## 当前边界
- 群聊只接受本机宿主、群内 Bot 以及平台系统通知，Bot 仅能被群消息 / `@`、`open_session` 回执与输入请求、`set_wakeup` 唤醒。
- 当前尚未内置面向外部服务器或单 Bot 的入站 HTTP Webhook 接口；本机 Gateway / Web 接口仅供宿主客户端使用（携带宿主最高权限令牌并以宿主身份发言），不可外放或挪作外部脚本回调口。
