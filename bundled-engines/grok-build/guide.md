# Grok Build 工作引擎维护指南

- 命令名：`grok`（官方 CLI，支持 `--prompt-file`、`--output-format streaming-json`、`--no-auto-update` 与 `--resume`）。
- 桥接脚本：`bridge.mjs` 将任务文本写入临时 prompt 文件后拉起 `grok`，流式解析 JSON 事件并在结束后清理临时文件。
- 认证方式：优先复用本机 `grok` CLI 登录态，也支持宿主机安全存储中的 `XAI_API_KEY`。
- 自检与自愈：
  1. 先用 `open_session({ engine: "exec", input: { shell: "grok --version" } })` 与 `grok --help` 检查本机安装与选项；
  2. 再用 `open_session({ engine: "grok-build", workspace: "ws-summon-home", work_summary: "验证 Grok Build 桥接连通性", input: { text: "只回复 OK，不修改任何文件。" } })` 端到端验证；
  3. 若未登录且需要 `XAI_API_KEY`，使用隐私输入窗（`kind: "secret"`, `secret_target: { kind: "env" }`, `env_name: "XAI_API_KEY"`）录入；
  4. 若上游参数或 JSON 事件格式变更，直接修改 `engines/grok-build/bridge.mjs` 并同步更新本指南。
