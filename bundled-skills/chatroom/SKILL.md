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

## 当前边界与设计提示
- 群聊只接受本机宿主、群内 Bot 以及平台系统通知，Bot 仅能被群消息 / `@`、`open_session` 回执与输入请求、`set_wakeup` 唤醒。
- 当前尚未启用面向外部服务器或单 Bot 的入站 Webhook / 推群接口。本机 Gateway / Web 接口仅供宿主本地客户端使用（需宿主最高权限令牌且会以宿主身份发言），不可外放或复用给外部脚本。
- 若业务要求“事件到达即及时推群”且忌讳高频定时唤醒烧 Token：不要把“每几分钟叫醒一次大模型轮询”直接当成最佳方案；先实查宿主机本机与远端是否已有现成网络通路（如 Tailscale、Cloudflare Tunnel、内网互通或现有事件服务），再如实对比「现有能力下的低频拉取折中（算清真实 Token/延迟代价）」与「依托两端现成通路、补齐最小本机零 Token 入站触发能力或轻量事件桥接」的治本路线。
