# Codex CLI 使用与维护指南

- 命令名：`codex`（Windows 下常见路径包含 `%APPDATA%\npm\codex.cmd`、npm vendor 内置 `codex.exe` 或 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`；macOS/Linux 常见 `~/.local/bin/codex` 或 `/opt/homebrew/bin/codex`）。
- 桥接脚本：`scripts/app-server.mjs` 启动 `codex app-server` 并通过 JSON-RPC 维护原生 `thread`、`turn`、实时进度、审批与 `turn/steer`。
- 协议自适配：脚本会自动探测 `codex app-server --help` 以选择 `--stdio`、`--listen stdio://` 或默认 stdio 入口。
- 默认执行策略：`sandbox: "danger-full-access"`、`approvalPolicy: "never"`；如用户要求只读或人工审批，可传 `sandbox: "read-only"` 或 `approvalPolicy: "on-request"`。
- 上游文档：`https://developers.openai.com/codex/app-server`
