# Grok Build CLI 使用与维护指南

- 命令名：`grok`（常见安装路径 `~/.grok/bin/grok.exe` / `~/.grok/bin/grok` 或 PATH）。
- 桥接脚本：`scripts/grok.mjs` 会探测 `--help`，自动选择 `--prompt-file` 或 `--single=...`，并优先使用 `streaming-messages-json` / `streaming-json` / `json` 输出格式，支持 `--resume` 续接，默认禁用自动更新提示（`GROK_DISABLE_AUTOUPDATER=1`）。
- 认证方式：优先复用本机 `grok` CLI 登录态，也可在宿主机保险箱配置 `XAI_API_KEY`。
- 上游文档：`https://docs.x.ai/build/cli/headless-scripting`
