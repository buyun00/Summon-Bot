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

各进程取得自身身份锁后打开日志，直接写入并轮转 `process.log`；不依赖父进程的管道。独立 Bot 的 `config.json` 使用 `logs`，部署配置的 `logs` 为 Web/网关默认值，`web.logs` 和 `gateway.logs` 可以分别覆盖：

```json
{
  "logs": {
    "maxFileBytes": 10485760,
    "maxFiles": 5,
    "retentionDays": 7,
    "sweepIntervalMs": 60000
  }
}
```

默认每个文件不超过 10 MiB，最多 5 个文件（含当前文件），保留 7 天，每分钟检查闲置日志。大块输出按完整 UTF-8 字符切段，容量达到上限立即轮转，并至多每日轮转一次；仅清理本目录中符合约定名称的日志。迁入的旧超大 `process.log` 只保留容量以内的最新文本。任务、工具事实与完整产物仍保存在 SQLite/artifacts，日志轮转不删除这些内容。修改配置后正常重启对应进程生效。

CLI 自动记录标准输出/错误；嵌入式 `startBot(config)` 默认保持宿主输出不变。需要由宿主独占管理进程日志时，可显式使用 `startBot(config, { captureProcessOutput: true })`；通用写入器公开为 `@relay/bot/process-log`。同一进程只能安装一个输出记录器，日志初始化失败会释放身份锁并报告启动错误。

StartupHub 沿用已有 `relay-bot` 条目和 `Relay Bot Foundation` 任务标识，任务动作已改为安装根的新 Start.ps1。这个名称只是 Windows 任务标识；旧 Foundation 程序及目录已不参与启动。重新注册使用安装包内 `scripts/installation/register-startup.ps1`，保留其他 Hub 条目和自动启动设置。

当前配置 8 个 Bot：工程、组件、质量、lumi，以及入口、聊天室、管理、记忆。角色模板数量不等于运行进程数量；Bot 按需启动，每个已运行实例独占自己的 Pi Agent 和数据目录。暂停 Web 不会停止它们；完整 Stop 才会关闭所有受管 Bot。

## 发行与升级

能力服务支持独立发布，操作见 [CAPABILITY_SERVICES.md](CAPABILITY_SERVICES.md)。`npm run relay:capabilities -- list` 可以查看版本、绑定和切换阻塞；`deploy` 从已校验发行物或自包含服务包启动一个新版本，不重启 Web、网关或 Bot。注册、激活、授权和退役分别记录；卸载不删除数据。仍被旧 Bot、长任务或待确认提交引用的发行目录必须保留，这是运行依赖，不是回退备份。

下面的完整安装流程用于替换 Bot 引擎、网关或 Web 基础程序，不能用于冒充能力热更新。网关端口和控制令牌必须稳定；不能在忙碌服务仍运行时随意重生成。

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
