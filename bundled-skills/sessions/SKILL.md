---
name: sessions
description: 异步后台执行任务（已启用的外部工作引擎、exec 命令/脚本、pi 轻量调研）
owner_bot: null
env_slots: []
---

# 后台执行与工作引擎（sessions）

## 怎么用
- **Summon Bot**：调用 `open_session` 启动异步会话，配合 `send_input`（`reply` / `steer` / `next`）续接或纠偏、`stop_session` 中断：
  - 已启用的外部工作引擎（如 `agy`、`codex`、`claude-code`、`grok-build`）：通过 `work_engines` 查看当前启用引擎与分档（`standard` / `deep` / `fast`），开放式现场摸底、排障、编码与架构评估优先整包委派；
  - `engine: "exec"`：运行确定性的单条本机命令（Windows 下为 PowerShell 5.1，顶层用 `;` 分隔勿用 `&&`）或自身 `scripts/*.mjs`；
  - `engine: "pi"`：轻量文本阅读与无外部工作引擎时的兜底。
- **工作引擎**：会话启动于授权工作区目录，进程环境变量中自动提供 `SUMMON_CAPABILITIES_DIR`（平台能力目录）、`SUMMON_KNOWLEDGE_DIR`（团队共享知识库）、`SUMMON_HOST_PROFILE_FILE`、`SUMMON_BOT_DIR` 以及调用方通过 `env` 显式注入的环境变量。
- **中断恢复**：若因后台更新或重启收到 `interrupted_by_restart`，由发起 Bot 按 `can_continue` 与任务幂等性决定续跑、重跑或同步宿主。
