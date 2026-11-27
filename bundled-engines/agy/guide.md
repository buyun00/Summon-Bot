# Antigravity (AGY) 工作引擎维护指南

- 命令名：`agy`（Windows 下常见路径为 `%LOCALAPPDATA%\agy\bin\agy.exe` 或 `%LOCALAPPDATA%\Microsoft\WinGet\Links\agy.exe`；macOS/Linux 常见 `~/.local/bin/agy` 或 `/usr/local/bin/agy`）。
- 桥接脚本：`bridge.mjs` 使用 `agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions --disable-slash-commands` 以 NDJSON 双向流驱动任务，支持默认模型 `gemini-4-neon-xhigh`（以及 `gemini-4-hydrogen-high` 等 `agy models` 中的模型）、实时工具进度上报、排队追加 `steer` 与 `--conversation` 会话续跑。
- 推荐模型组合：
  - `gemini-4-neon-xhigh`（深度排障、架构设计与复杂工程实现）
  - `gemini-4-hydrogen-high`（快速侦察、常规脚本与中等复杂度任务）
- 自检与自愈：
  1. 用 `open_session({ engine: "exec", input: { shell: "agy --version; agy models" } })` 检查本机安装、登录状态与可用模型清单；
  2. 再用 `open_session({ engine: "agy", workspace: "ws-summon-home", work_summary: "验证 AGY 桥接连通性", input: { text: "只回复 OK，不修改任何文件。", model: "gemini-4-hydrogen-high" } })` 端到端验证；
  3. 若报 `authentication required`，提示宿主在终端执行一次交互式 `agy` 完成账号登录；
  4. 若上游 `agy` 参数或 `stream-json` 协议变更，直接通过 `read` / `save_file`（`{ kind: "engine", id: "agy" }`）更新 `bridge.mjs` 与本指南。
- 上游文档：`https://antigravity.google/docs/cli/headless`
