# Claude Code 工作引擎维护指南

- 合规要求：只调用官方未修改的本机 `claude` CLI，不抓取 OAuth token 或冒充客户端头直连私有接口。
- 桥接脚本：`bridge.mjs` 使用 `claude --print --output-format stream-json --verbose` 并通过 `--resume <session_id>` 支持多轮续接。
- 认证方式：支持本机 `claude` 官方 CLI 订阅登录，也支持宿主机安全存储中的 `ANTHROPIC_API_KEY`。
- 自检与自愈：
  1. 先用 `open_session({ engine: "exec", input: { shell: "claude --version" } })` 与 `claude --help` 检查安装与参数；
  2. 再用 `open_session({ engine: "claude-code", workspace: "ws-summon-home", work_summary: "验证 Claude Code 桥接连通性", input: { text: "只回复 OK，不修改任何文件。" } })` 验证端到端响应；
  3. 未登录时提示用户在终端完成 `claude` 登录或通过隐私输入窗配置 `ANTHROPIC_API_KEY`；
  4. 若上游参数或 `stream-json` 结构变更，直接修改 `engines/claude-code/bridge.mjs` 并同步更新本指南。
