# Codex 桌面连接器

Relay-Bot 内置的本机 HTTP/SSE API，连接已运行的 Codex 桌面，监听 `http://127.0.0.1:47831`。支持项目/聊天列表、创建和续发、状态与历史、SSE、中断、额度及 webhook。接口见 `docs/openapi.json`；不另起 Codex 执行器。

代码随 Relay 正式发行打包，实际运行安装目录 current.json 选择的版本。配置、SQLite 幂等记录、事件和日志统一放在 `D:/Relay-Bot-data/connectors/codex-desktop-api`。配置文件为 `config.json`，可参考 `config.example.json`；真实 token 和桌面调用上下文不进入源码。

开机助手沿用任务 `Codex Desktop API`，显示为“Relay Bot · Codex 连接器”。其入口为本项目的 `Run-Hidden.vbs`：由无控制台的 wscript 启动隐藏 PowerShell，并等待托管 Node 的整个生命周期；Windows Job Object 随任务关闭子进程。没有新增登录触发器。

- 手动启动：双击 `Start-Hidden.vbs`，不显示控制台窗口。
- 停止：运行 `Stop.ps1` 或在开机助手中停止此条目，不影响 Codex 桌面。
- 更新开机助手路径：停止旧 API 后运行 `Install-StartupHub.ps1`，保留现有自启开关及其他条目。
- 更新连接器：按仓库正式构建、安装流程更新，再停止/启动本连接器。启动器每次读取最新 current.json。
- 日志：数据目录内 `startup.log`、`server.log`、`server-error.log`。

Codex 中继 Bot 的 Skill 是 `skills/codex-desktop-api`，通过普通命令工具调用这个 API。API 是独立连接器，不是 Codex 桌面的某个可开启选项。请求受理不等于工作完成；未知写请求按原幂等键查询，不换键重发。
