---
name: sessions
description: 异步后台执行任务（pi 轻量调研、exec 单条命令/脚本、及已启用的外部工作引擎）
owner_bot: null
env_slots: []
---

# 后台执行与工作引擎（sessions）

## 怎么用
- **Summon Bot**：调用 `open_session` 启动异步会话，配合 `send_input`（`reply` / `steer` / `next`）续接或纠偏、`stop_session` 中断：
  - `engine: "pi"`：轻量 AI 调研与阅读；
  - `engine: "exec"`：单条本机命令（Windows 下为 PowerShell 5.1，顶层用 `;` 分隔勿用 `&&`）或自身 `scripts/*.mjs`；
  - 已启用的外部工作引擎（如 `codex`、`claude-code`、`grok-build`）：先用 `find({ kind: "engine" })` 核对当前实际安装与启用状态，多文件工程、重构与复杂排障优先使用。
- **工作引擎**：会话启动于授权工作区目录，进程环境变量中自动提供 `SUMMON_CAPABILITIES_DIR`（指向本机平台能力目录，可直接读取各 `<id>/SKILL.md`）以及调用方通过 `env` 显式声明的环境变量。

## 当前边界与设计提示
- `open_session` 面向**有终点的命令与任务**，不适合直接充当 7×24 永不退出的常驻守护进程（未退出的会话会阻塞后台更新排空，也会随宿主机休眠/重启中断）。
- 若确需本机低开销常驻监听（零 Token 静默等待事件），应评估宿主机自身操作系统级服务/计划任务或与远端现有通道（如 Tailscale / Cloudflare）的轻量衔接，而不是把长驻死循环塞进 `open_session` 或靠高频 `set_wakeup` 反复唤醒大模型。
- 若因后台更新或重启收到 `interrupted_by_restart`，由发起 Bot 按任务是否只读/幂等决定续跑、重跑或同步宿主。
