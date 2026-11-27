---
name: wakeups
description: 定时、周期或按群事件唤醒指定 Bot
owner_bot: null
env_slots: []
---

# 定时与事件唤醒（wakeups）

## 怎么用
- **Summon Bot**：调用 `set_wakeup` 为指定 Bot 创建或更新唤醒规则（由本机 Summon 服务进程调度，本机在线时生效）：
  - `kind: "time"`：一次性时间提醒（带时区的 ISO 时间 `at`）；
  - `kind: "recurring_time"`：周期定时唤醒（`at` + `interval_ms`，最小 `1000`）；
  - `kind: "event"`：按群内事件或消息类型触发。
