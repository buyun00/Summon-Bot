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

创建对话会先读取桌面已保存的本机默认权限，再用真实 IPC 快照选择、复核一个内置权限完全匹配的已加载调用上下文。桌面原生创建工具从该上下文继承权限，用户原始 prompt 一次提交即为首轮；没有额外准备消息，也不在首轮开始后补改权限。选中的上下文保持加载，每次创建重新读取默认值和权限。

“完全访问”对应 `:danger-full-access` / `dangerFullAccess` / `never` / `user`。响应新增 `permissionInheritance`，含 `contextVerifiedBeforeFirstMessage` 和 `verifiedAfterCreation`。已有 API 请求不需要添加权限参数，续发现有对话仍保持该对话原权限。

没有匹配的已加载本机上下文时返回 `503 permission_context_unavailable`，不创建对话或执行 prompt；在桌面打开一条使用默认权限的本机 Codex 对话即可。目前支持 full-access/read-only/auto/granular 内置选择；其他选择返回 501，不猜测或降权。真实首轮验证覆盖 Windows 桌面 26.1027.3384.0 的完全访问 + never；其他模式仅模拟验证，远程主机及其他版本未做该项验证。用户全局状态文件仅读取，不修改 Codex 安装、用户配置或私有数据库。

已接受创建但后续权限回读失败时，操作为 unknown，并返回已有 threadId。先检查原操作，禁止换新幂等键重发。经明确授权后可用 `scripts/smoke-permissions.js --write` 验证专用新对话首轮的仓库外写入、.git 写入和联网；`--project` 覆盖现有 Codex-Desktop-API 项目。脚本保存尝试后不重复创建，后续只允许 `--resume` 接续已确认的同一测试对话。
