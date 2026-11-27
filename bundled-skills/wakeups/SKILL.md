---
name: wakeups
description: 定时、周期或按群事件唤醒指定 Bot（本机调度，宿主机在线期间生效）
owner_bot: null
env_slots: []
---

# 定时与事件唤醒（wakeups）

## 怎么用
- **Summon Bot**：调用 `set_wakeup` 为指定 Bot 创建或更新唤醒规则：
  - `kind: "time"`：一次性时间提醒（带时区的 ISO 时间 `at`）；
  - `kind: "recurring_time"`：周期定时唤醒（`at` + `interval_ms`，最小 `1000`）；
  - `kind: "event"`：按群内事件或消息类型触发。
- **工作引擎**：工作引擎不直接注册定时任务；若方案需要定期巡检或提醒，建议由 Summon Bot 通过 `set_wakeup` 定期触发轻量脚本/命令，并明确说明轮询频次与 Token 开销。

## 当前边界
- 调度运行在宿主机 Summon 服务进程内；宿主机休眠、关机或服务停止期间不会触发，恢复后按规则处理。
