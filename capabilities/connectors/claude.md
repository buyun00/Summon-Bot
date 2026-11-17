# Claude Code

连接器 ID 是 `claude-code`，命令为 `claude`。Windows 安装可包含 npm shim 和 npm 包内的 `claude.exe`，连接器优先使用可直接启动的可执行文件。CLI 使用本机 Claude Code 登录，宿主用户也可配置原生凭据引用。Pi 沿用 Bot 的模型绑定。

以 `--print` 从 stdin 提交文本，按本机帮助选择 `stream-json`、JSON 或文本。流式模式需要时使用 `--verbose`。沿用 Claude Code 当前权限设置。有 `--permission-prompts none` 时由 CLI 处理需要互动许可的请求，并呈现实际的权限拒绝。

使用 CLI 输出的 `session_id` 和明确传给 `--resume` 的 ID 进行下一轮，前提是实际版本提供相应选项。Summon 提供当前执行输出、已观测历史和进程停止。内置 print 连接接收逐轮输入，供应商原生历史与交互许可需要相应适配。

[Claude Code CLI](https://code.claude.com/docs/en/cli-reference) · [以程序方式运行 Claude Code](https://code.claude.com/docs/en/headless)
