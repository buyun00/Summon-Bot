# 运行维护

按 [DEVELOPMENT.md](DEVELOPMENT.md) 执行当前开发约定：修改完成后直接交付或按授权运行。用户未另行明确要求时，不运行或补写测试、不计算或比对哈希、不追加重复验收，不以额外回执、证据文件或流程报告拖延交付。实际操作出现错误时只处理具体错误。

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

主联系人列表只显示用户创建的 Bot。七个系统预置实例通过持久化 `presetId` 收到“系统 Bot”入口中，展开后仍可查看和对话。角色名、名称或加载的 Skill 不决定归属；用户创建和复制的实例使用同一 Bot 内核，默认不继承预设标记。

## 清空对话历史

用户明确要求清空历史时，先记录当前运行意图，再正常停止全部受管服务和 Bot，执行：

```powershell
npm run relay:history -- --data-root D:/Relay-Bot-data
```

命令要求显式数据根，并在取得系统、Bot 和能力服务的排他身份锁后处理数据库。它清除对话、模型会话上下文、任务、工具调用、投递与相关执行历史，清空旧同步快照；保留 Bot 配置、长期记忆、用户持久状态、知识、房间成员及已有文件和产物。不生成历史备份。输出只记录清理计数和保留数据摘要，失败时不能宣称已完成。

数据根 `history.json` 保存新的 `historyEpoch`。新版电脑和 PWA 页面收到变化后清除旧消息缓存和已发送记录，保留未发送草稿；旧请求响应不能写回旧历史。已安装的 PWA 在“连接应用”中应用新版本后生效。清理完成后再恢复原运行意图；不要通过发送生产测试消息重新填入刚清空的历史。

任务重试按 `retryOf` 关联已有尝试，重复点击复用在途或已完成尝试；已经存在明确对应回复的旧中断记录不会再次执行。失败提示贴在对应触发消息处，不持续显示在无关新回复底部。

## 发行与升级

能力服务支持独立发布，操作见 [CAPABILITY_SERVICES.md](CAPABILITY_SERVICES.md)。`npm run relay:capabilities -- list` 可以查看版本、绑定和切换状态；`deploy` 从发行物或自包含服务包启动一个新版本，不重启 Web、网关或 Bot。注册、激活、授权和退役分别记录；卸载不删除数据。仍被旧 Bot 或长任务引用的发行目录是实际运行依赖，按当前任务需要处理。

下面的完整安装流程用于替换 Bot 引擎、网关或 Web 基础程序，不能用于冒充能力热更新。网关端口和控制令牌必须稳定；不能在忙碌服务仍运行时随意重生成。

需要更新安装时，构建发行物，正常停止当前系统后运行 `relay:install`，再按授权启动。这个流程不前置测试、哈希比对或额外验收。新发行使用独立目录；选择结果保存到安装根 current.json 和数据根 deployment.json。旧发行按用户要求和实际运行依赖处理，数据目录不随代码替换。

manifest 的 `sourceCommit` 是构建时 Git HEAD，`sourceDirty` 表示是否包含当时未提交的工作区变更。旧发行物和历史报告中的 SHA-256、`contentHash` 只作为历史元数据保留，不要求开发过程计算、比对或补齐这些字段。

用户已明确要求不制作备份或回退副本；迁移保留有效业务数据，按授权移除被替代目录，不额外生成目录备份。

## 历史数据迁移说明

此前的迁移使用 `scripts/migration/migrate.mjs`，默认只读预览，`--execute` 执行迁移。现场旧来源已清除，这不是日常开发或更新步骤，不应再运行旧迁移。

当时按原 IDs 分配公共聊天室、知识、Codex、Bot 管理与各 Bot 私有数据；同 ID 执行记录以工作进程数据库为准。原会话 ID 保留，并用 contextKey 续接房间。附件、产物和记录的历史校验结果保存在 migration/layout-v2.json。上述内容说明已发生的迁移，不要求后续开发重复哈希、迁移或验收；迁移程序也不是持续同步或恢复工具。

清理范围遵循用户授权，不删除外部工作项目。故障时报告具体失败操作和实际原因，不补设报告或验收门禁。

## 分身

通过管理能力的 bots_clone 创建，requestId 提供幂等性；通过 bots_deliver 持久交付，memory_propose / memory_merge 处理记忆增量，bots_recycle 回收。母体和子体始终独立。保留成果引用；临时目录清理只在任务终态且无活动工具时进行。

## 运行结果说明

只报告实际执行的操作和结果，未执行的事项不写通过。此前测试、模型调用、浏览器及安装记录保留在 [VERIFICATION.md](VERIFICATION.md)，其中的未验证项不构成后续开发待办，不自动补跑。
