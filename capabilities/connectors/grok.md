# Grok Build

连接器 ID 是 `grok-build`，命令为 `grok`。Windows 可直接启动 `grok.exe`，标准用户安装也会放在 `.grok/bin`。注册时检查本机 `--version`、`--help` 和公开选项。连接器使用本机 Grok 登录，宿主用户也可通过已配置的 `XAI_API_KEY` 引用授权 CLI。Pi 的 Grok 订阅配置与这项执行授权独立。

连接器通过 `--prompt-file` 或已装版本的单轮参数提交任务。可用时采用 `streaming-messages-json` 或 `streaming-json`，否则选择已公开的 JSON 或纯文本输出。调用以已获准的项目目录作为 CWD，沿用 Grok 当前权限配置。会话记录实际文本、工具失败、stderr 诊断和终态。

当前任务需要调整 CLI 选项时，先查看该安装的帮助，再用 `adapter.arguments` 登记实际需要的参数组。Grok 的输出解析和会话 ID 处理继续走内置连接器。

CLI 通过结构化输出确认会话 ID 并支持 `--resume` 时，可以在现有 Session 用 `next` 继续。运行期间可以经 `stop_session` 停止进程。当前 headless 连接支持逐轮输入和 Summon 已观测的输出历史。ACP 示例如需额外的审批、实时输入或历史能力，可根据本机的 `grok agent stdio` 接口制作适配，并只声明实际接通的操作。

[Grok Build Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting) · [xAI 的原生事件文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md) · [Grok Build 权限](https://docs.x.ai/build/features/permissions)
