# Codex

连接器 ID 是 `codex`，命令为 `codex`。Windows 的 npm 与桌面安装都可能提供独立 `codex.exe`。初始化时读 `app-server --help`，选该版本公开的 `--stdio`、`--listen stdio://` 或 stdio 默认入口。

内置 app-server 连接使用 Codex 的本机登录或宿主已绑定的环境凭据引用。它保持原生 thread 和 turn、输出流、历史回读及停止。下一轮、实时 steer 和审批回复依赖当前 Session 返回的真实目标。遵循原生审批要求和工作目录授权。保留已登记的 Codex 连接及其原生会话关系，协议变动时按现有连接配置与状态决定续接方式。

[Codex App Server](https://developers.openai.com/codex/app-server) · [OpenAI 的 app-server 协议源码说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
