# Claude Code CLI 使用与维护指南

- 命令名：`claude`（Windows 常见 `%USERPROFILE%\.local\bin\claude.exe`、`%APPDATA%\npm\claude.cmd` 或 npm 包内 `claude.exe`；macOS/Linux 常见 `~/.local/bin/claude` 或 PATH）。
- 桥接脚本：`scripts/claude.mjs` 使用官方 `--print` 模式通过 stdin 传递任务文本，按 `--help` 自动启用 `--output-format stream-json --verbose` 与 `--resume` 续接。
- 认证边界：复用本机官方 `claude` CLI 订阅登录仅用于后台任务执行，不用于第三方直连模型 API。
- 上游文档：`https://code.claude.com/docs/en/headless`
