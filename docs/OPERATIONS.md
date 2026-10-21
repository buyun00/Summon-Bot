# 运行维护

## 配置

当前现场：源码 `D:/Relay-Bot`，安装 `D:/Relay-Bot-app`，数据 `D:/Relay-Bot-data`。浏览器入口保持 `https://bot.lin0.org` 和 `http://127.0.0.1:8787`；本机能力网关端口已固定为 53119。运行代码由 `deployment.json` 指定，不从源码目录热加载。

`config/deployment.json` 位于数据根，声明发行路径、工作目录、模型、Web 和能力网关地址。控制令牌和 Bot 凭据只存在本机数据目录，不提交 Git。`config/runtime.env` 是显式凭据来源，例如 `DEEPSEEK_API_KEY=...`；不会自动搜索其他项目。

每个 Bot 的 `config.json` 可配置模型、提示词、skills、HTTP/module/MCP tools、contacts、peers、并发与预算。独立使用示例见 `bot/README.md` 与 `bot/examples/`。

## 日常启停

- `Start.ps1 -DataRoot <数据根>` 启动，已就绪实例不重复启动。
- `Start.ps1 -Foreground -RespectIntent` 供 StartupHub 跟踪；尊重此前保存的停止意图。
- `Stop.ps1 -DataRoot <数据根>` 正常停止所有 Bot、Web 和网关；身份无法确认时报告错误，不按陈旧 PID 杀进程。
- `npm run relay:status -- --data-root <数据根>` 查询真实控制接口。

Web 日志在 `web/logs/`，网关日志在 `capabilities/gateway/logs/`，各 Bot 日志在 `bots/<botId>/logs/`。run/current.json 用于发现控制地址；控制端校验 bootId 与身份。

StartupHub 沿用已有 `relay-bot` 条目和 `Relay Bot Foundation` 任务标识，任务动作已改为安装根的新 Start.ps1。这个名称只是 Windows 任务标识；旧 Foundation 程序及目录已不参与启动。重新注册使用安装包内 `scripts/installation/register-startup.ps1`，保留其他 Hub 条目和自动启动设置。

当前配置 8 个 Bot：工程、组件、质量、lumi，以及入口、聊天室、管理、记忆。角色模板数量不等于运行进程数量；Bot 按需启动，每个已运行实例独占自己的 Pi Agent 和数据目录。暂停 Web 不会停止它们；完整 Stop 才会关闭所有受管 Bot。

## 发行与升级

先运行测试、构建和 manifest 校验；正常停止当前系统后运行 `relay:install`。新发行目录不可覆盖已有内容；选择结果保存到安装根 current.json 和数据根 deployment.json。旧发行在新发行实际验证后按受控路径删除。数据目录不随代码替换。

manifest 的 `sourceCommit` 是构建时 Git HEAD，`sourceDirty` 表示是否包含当时未提交的工作区变更；精确发行内容由逐文件 SHA-256 和 `contentHash` 标识。最终交付记录将发行内容哈希与实际推送的提交关联。

本次用户明确要求不制作备份或回退副本；因此迁移保留并校验有效业务记录，切换后移除被替代目录，不额外生成目录备份。

## 数据迁移

`node scripts/migration/migrate.mjs --source-root <旧源码根> --data-root <数据根> --release-root <新发行根>` 默认只读预览。停止旧实例后添加 `--execute`。

迁移按原 IDs 分配公共聊天室、知识、Codex、Bot 管理与各 Bot 私有数据；同 ID 执行记录以工作进程数据库为准。原会话 ID 保留，并用 contextKey 续接房间。未确认工作只作为历史保留，需明确重试。附件和产物逐文件 SHA-256 校验，映射和原记录哈希写入 migration/layout-v2.json。输入和已迁入记录均未变化时再次执行为 unchanged；变化时拒绝覆盖。生产启用后记录会正常变化，迁移程序不是持续同步或恢复工具；现场旧来源已清除，不应再执行旧迁移。

删除旧根前核对：报告完整、有效记录/附件能读取、新服务运行、旧进程已退出。不要删除外部工作项目。故障时查看具体失败状态，不能把未知外部动作当作成功或自动重试。

## 分身

通过管理能力的 bots_clone 创建，requestId 提供幂等性；通过 bots_deliver 持久交付，memory_propose / memory_merge 处理记忆增量，bots_recycle 回收。母体和子体始终独立。保留成果引用；临时目录清理只在任务终态且无活动工具时进行。

## 验证边界

自动测试、真实模型、真实 Codex、浏览器、安装后运行和登录自启是不同证据。测试详情与未验证项记录在 VERIFICATION.md；没有实际重启或真机验证时不写通过。
