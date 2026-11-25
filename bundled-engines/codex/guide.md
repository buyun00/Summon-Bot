# Codex 工作引擎维护指南

- 命令名：`codex`（Windows 下常见路径包含 `%APPDATA%\npm\codex.cmd`、npm vendor 内置 `codex.exe` 或 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`；macOS/Linux 常见 `~/.local/bin/codex` 或 `/opt/homebrew/bin/codex`）。
- 桥接脚本：`bridge.mjs` 启动 `codex app-server` 并通过 JSON-RPC 维护原生 `thread`、`turn`、实时进度、审批与 `turn/steer`。
- 默认执行策略：`sandbox: "danger-full-access"`、`approvalPolicy: "never"`；如任务要求只读或人工审批，调用方可传 `sandbox: "read-only"` 或 `approvalPolicy: "on-request"`。
- 自检与自愈：
  1. 先用 `open_session({ engine: "exec", input: { shell: "codex --version" } })` 与 `codex app-server --help` 检查本机安装与协议；
  2. 再用 `open_session({ engine: "codex", workspace: "ws-summon-home", work_summary: "验证 Codex 桥接连通性", input: { text: "只回复 OK，不修改任何文件。", sandbox: "read-only" } })` 端到端验证；
  3. 未安装时提示 `npm i -g @openai/codex`；未登录时提示执行 `codex login`；
  4. 若上游 `codex app-server` 参数或事件格式变更，直接通过 `read` / `save_file`（`{ kind: "engine", id: "codex" }`）修改 `bridge.mjs` 并同步更新本指南。
- 上游文档：`https://developers.openai.com/codex/app-server`
