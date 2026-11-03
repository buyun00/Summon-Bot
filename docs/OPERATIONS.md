# 运行维护

按 [DEVELOPMENT.md](DEVELOPMENT.md) 执行当前开发约定：修改完成后直接交付或按授权运行。用户未另行明确要求时，不运行或补写测试、不计算或比对哈希、不追加重复验收，不以额外回执、证据文件或流程报告拖延交付。实际操作出现错误时只处理具体错误。

## 配置

当前现场：源码 `D:/Relay-Bot`，安装 `D:/Relay-Bot-app`，数据 `D:/Relay-Bot-data`。浏览器入口保持 `https://bot.lin0.org` 和 `http://127.0.0.1:8787`；本机能力网关端口已固定为 53119。运行代码由 `deployment.json` 指定，不从源码目录热加载。

`config/deployment.json` 位于数据根，声明发行路径、工作目录、模型、Web 和能力网关地址。控制令牌和 Bot 凭据只存在本机数据目录，不提交 Git。`config/runtime.env` 是显式凭据来源，例如 `DEEPSEEK_API_KEY=...`；不会自动搜索其他项目。

每个 Bot 的 `config.json` 可配置模型、提示词、skills、HTTP/module/MCP tools、contacts、peers 和上下文压缩。任务不设模型轮数、工具调用次数或总执行时长上限。`limits` 只接受 reserveTokens、keepRecentTokens。`concurrency` 默认 4；`context.maintenanceConcurrency` 默认 1，`maxSummaryTokens` 默认 8192，`maxAssemblyTokens` 默认 6144。用户取消、服务关闭和实际调用错误仍正常生效。独立使用示例见 `bot/README.md` 与 `bot/examples/`。

上下文继续使用 PiAgent 的消息、工具与历史投影。压缩、整理、组装分别在需要时创建新的短暂维护对话；常规压缩不再调用另一套 Pi 自动摘要。S1 原文保存在 SQLite；S2 唯一正文位于每个 Bot 的 knowledge/*.md；S3 的目标、来源、进度、等待、外部绑定和通知位于同一个 SQLite。整理游标只有在 MD/Skill 成功写入后才前移，重启继续待处理批次。当前输入与未整理尾部立即进入工作；失败保留原上下文与原始记录，不重发未知副作用。

新建普通 Bot 使用 `default` 角色时，默认挂载 Pi 风格的四项基础工具：`read_file`（读文件）、`write_file`（写文件）、`edit_file`（修改文件）和 `run_command`（执行命令），并保留已有的协作与自身记忆能力。这四项工具由独立的 filesystem 能力服务提供，Bot 引擎负责调用。文件工具可访问该 Bot 的 workspace 和已配置的项目目录；命令以宿主用户身份运行，工作目录约定不等于操作系统沙箱。角色模板变更用于新建实例，已有 Bot 通过能力授权更新其工具配置。

## 日常启停

Codex 桌面 API 已整合到 `connectors/codex-desktop-api` 并随正式发行打包。开机助手条目“Summon Bot · Codex 连接器”沿用 `Codex Desktop API` 任务，由本项目 `Run-Hidden.vbs` 无控制台启动，实际运行 current.json 选择的已安装代码。配置、事件与幂等数据库、日志在 `D:/Relay-Bot-data/connectors/codex-desktop-api`。手动启动双击该连接器的 `Start-Hidden.vbs`；停止用其 `Stop.ps1`。连接器更新后需单独重启该任务；不再使用原 `D:/Codex-Desktop-API` 服务入口。

- 双击安装根的 `Start-Hidden.vbs` 无窗口启动；`Run.cmd` 也转交该入口，不保留终端窗口。命令行仍可使用 `Start.ps1 -DataRoot <数据根>`，已就绪实例不重复启动。
- StartupHub 使用 `wscript.exe //B //NoLogo Start-Hidden.vbs -Foreground -RespectIntent -DataRoot <数据根>`；无窗口宿主等待 PowerShell 和看门狗退出，任务全程保持运行并尊重此前保存的停止意图。
- 正式 `Start.ps1` 启动后会拉起已有的 `Summon Bot` 任务。前台任务持有独占身份锁，每 5 秒检查 Web/网关，仅在确认进程停止时自动恢复；连续失败按 5/10/20/40/60 秒退避，稳定运行 60 秒后清零。身份不明或暂时无响应时保留原进程，不启动副本。
- 看门狗日志在 `web/watchdog/process.log`，沿用日志轮转，记录状态、重启尝试、恢复及其子进程退出码。`Stop.ps1` 保存停止意图后，看门狗退出，不会反复拉起；任务自身异常退出由 Windows 以 1 分钟间隔重试（最多 999 次）。
- 2026-10-28 实测本机按需任务的 Windows 失败重试未触发，不能将该设置视为恢复保证。任务内的 PowerShell 启动器保持常驻；Node 看门狗退出后等待 60 秒重新拉起，重试前再次读取停止意图。此层事件记录在 `web/logs/startup.log`。结束整个计划任务不等同于结束 Node 看门狗。
- `Stop.ps1 -DataRoot <数据根>` 正常停止所有 Bot、Web 和网关；身份无法确认时报告错误，不按陈旧 PID 杀进程。
- `npm run summon:status -- --data-root <数据根>` 查询真实控制接口。

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

CLI 自动记录标准输出/错误；嵌入式 `startBot(config)` 默认保持宿主输出不变。需要由宿主独占管理进程日志时，可显式使用 `startBot(config, { captureProcessOutput: true })`；通用写入器公开为 `@summon/bot/process-log`。同一进程只能安装一个输出记录器，日志初始化失败会释放身份锁并报告启动错误。

StartupHub 沿用已有 `summon-bot` 条目和 `Summon Bot` 任务标识，任务动作使用安装根的 `Start-Hidden.vbs`，内部运行同目录的 `Start.ps1`。这个名称只是 Windows 任务标识；旧 Foundation 程序及目录已不参与启动。重新注册使用安装包内 `scripts/installation/register-startup.ps1`，保留其他 Hub 条目和自动启动设置。

Bot 按需启动，每个实例拥有自己的数据目录，同一 Bot 内的不同工作各自持有 Pi Agent。角色模板数量不等于运行进程数量。暂停 Web 不会停止它们；完整 Stop 才会关闭所有受管 Bot。

主联系人列表只显示用户创建的 Bot。八个系统预置实例（包含 EggBot）通过持久化 `presetId` 收到“系统 Bot”入口中，展开后仍可查看和对话。角色名、名称或加载的 Skill 不决定归属；用户创建和复制的实例使用同一 Bot 内核，默认不继承预设标记。

## Token 统计

网页“设置与应用 → Token 统计”统一展示 Bot、单聊和群聊用量，可按今天、昨天、近 7 天和累计筛选，按 Token、参考费用、缓存未命中或调用次数排序。点击排行可看来源、模型、每日用量和逐次请求；会话内的多个 Bot 合并统计，后台压缩、整理、组装计入能明确归属的会话，其余列为未归属。

正式环境的每次模型 HTTP 调用统一写入数据根 `usage.sqlite`，独立于 Bot、会话和任务目录，包括失败和取消；清理临时 Bot 或聊天历史不删除计费记录。各 Bot 的 `usage.ledgerPath` 指向该全局账本；独立 Bot 默认使用自身数据目录的 `usage.sqlite`。先保存接口返回的 Token，再校验回答，避免丢掉已计费但内容无效的调用；断线和进程中断没有回执的部分标为未知。重启时仅将本 Bot 未完成的请求标为结果未知。`GET /api/usage` 支持 `period=today|yesterday|7d|all`、可选 `botId` / `roomId` 和分页；时间边界固定为 Asia/Shanghai。已删除的 Bot 仍可按原身份查询其用量。

缓存命中率为已返回缓存明细的命中输入 / 总输入，不对请求百分比取平均；推理 Token 包含在输出内。DeepSeek 只提供输入缓存命中，没有独立的输出命中指标。费用按核对日的官方美元低峰至高峰价格显示参考区间，未知模型或没有缓存回执的调用不估价，不能代替供应商账单。历史回填只使用已保存的 assistant 用量及 maintenance.usage 事件；采集启用前的数据明确标为不完整，留存明细命中率不能冒充全天或整个 API Key 的命中率。

用户提供的供应商日统计保存在同一账本的 `provider_usage`，单独标注来源、日期、API Key 显示名称、币种和总量。页面按该日展示供应商总量、本机明细及差额；缺失请求不伪造输入/输出、不分摊到 Bot 或会话。截图数据为人工记录，不声称已连接供应商后台或实时同步。供应商 CNY 消费与本机 USD 参考费用不直接相减。

## 清空对话历史

用户明确要求清空历史时，先记录当前运行意图，再正常停止全部受管服务和 Bot，执行：

```powershell
npm run summon:history -- --data-root D:/Relay-Bot-data
```

命令要求显式数据根，并在取得系统、Bot 和能力服务的排他身份锁后处理数据库。它清除对话、模型会话上下文、任务、工具调用、投递与相关执行历史，清空旧同步快照；保留 Bot 配置、长期记忆、用户持久状态、知识、房间成员及已有文件和产物。不生成历史备份。输出只记录清理计数和保留数据摘要，失败时不能宣称已完成。

数据根 `history.json` 保存新的 `historyEpoch`。网页和桌面页面收到变化后清除旧消息缓存和已发送记录，保留未发送草稿；旧请求响应不能写回旧历史。网页版本刷新后生效。清理完成后再恢复原运行意图；不要通过发送生产测试消息重新填入刚清空的历史。

任务重试按 `retryOf` 关联已有尝试，重复点击复用在途或已完成尝试；已经存在明确对应回复的旧中断记录不会再次执行。失败提示贴在对应触发消息处，不持续显示在无关新回复底部。

## 发行与升级

客户端下载来源、Windows 本地发布、macOS/Android GitHub Actions 和各端更新方式，见 [客户端发行与更新](CLIENT_RELEASES.md)。常规完整发布在源码提交推送后运行 `npm run release:all`，仅本地打包 Windows，沿用本节的正式安装和清理流程；iOS 暂不打包发布。

Windows 正式发行使用 Node 24.21.0 LTS 构建并随包携带该运行时，启动脚本自动使用包内 `runtime/node.exe`，不需要替换系统 Node。不要使用 24.15.0 / 25.8.0 打包：这些版本存在 Windows TCP keepalive 原生栈越界，构建入口已拒绝它们。上游修复见 [nodejs/node#62561](https://github.com/nodejs/node/pull/62561)。在指定运行时下运行 `node.exe scripts/build/build.mjs --bundle-node`，其余安装流程不变。

网页 Bot 详情中的“直连联系人”可建立或断开两个现有 Bot 的双向连接。连接使用独立、按方向区分的对端令牌，不共享管理令牌；重复提交可完成中途失败的配置。已有连接保存在各 Bot 配置中。本机联系人通过对端自己的身份管道解析当前地址，所以对端重启换端口后不需要经过网关刷新地址。`contacts_list`、`messages_send`、带 `botId` 的 `tasks_get` / `tasks_cancel` 都是 Bot 内核直连能力，已建立的连接不依赖聊天室或网关在线。暂停的 Bot 拒绝新的直连请求；断开连接撤销双方后续访问，不中断已开始的任务。当前网页建立的是同机直连，不代表跨机器公网连通。

能力服务支持独立发布，操作见 [CAPABILITY_SERVICES.md](CAPABILITY_SERVICES.md)。`npm run summon:capabilities -- list` 可以查看当前版本、绑定和切换状态。开发阶段每个服务只保留当前版本；更新时先完成任务边界切换，再删除被替代版本及其配置，业务数据继续保留。

下面的完整安装流程用于替换 Bot 引擎、网关或 Web 基础程序，不能用于冒充能力热更新。网关端口和控制令牌必须稳定；不能在忙碌服务仍运行时随意重生成。

需要更新安装时，构建发行物，正常停止当前系统和连接器后运行 `summon:install -- --release-root <构建目录> --app-root D:/Relay-Bot-app --data-root D:/Relay-Bot-data --source-root D:/Relay-Bot`，再启动。这个流程不前置测试、哈希比对或额外验收。安装结果写入 current.json 和 deployment.json，只保留选中的发行目录。

完整安装会重建当前内置能力配置和 Bot 绑定，更新 Bot 内核、Skill、模块与工具路由引用，删除被替代的能力运行目录、旧配置和构建中间目录。历史请求、对话、记忆、工具事实及用户文件继续保留。

manifest 的 `sourceCommit` 是构建时 Git HEAD，`sourceDirty` 表示是否包含当时未提交的工作区变更。旧发行物和历史报告中的 SHA-256、`contentHash` 只作为历史元数据保留，不要求开发过程计算、比对或补齐这些字段。

用户已明确要求不制作备份或回退副本；迁移保留有效业务数据，按授权移除被替代目录，不额外生成目录备份。

清理范围遵循用户授权，不删除外部工作项目。故障时报告具体失败操作和实际原因，不补设报告或验收门禁。

## 工作与持续职责

统一 MCP、HTTP API 与共享 Skill 的管理入口为网页“设置与应用 → 能力目录”，配置、责任关系、并发资源引用与方法维护说明见 [CAPABILITY_CATALOG.md](CAPABILITY_CATALOG.md)。连接凭据只引用正式 runtime.env。目录登记不扩大业务授权，失败与未知写入不会自动重放。

普通任务由 work_create 建立，不再提供克隆、分身交付和记忆合并入口。work_wait 持久记录外部等待并释放执行位；外部事件、同伴终态或到期条件唤醒原工作。暂停/取消后迟到事件只保存，显式恢复才继续。重复相同观察停止该无进展链，保留工作，不对正常任务设置总轮数、时长或工具次数截止。

新 Codex 工作只经已整合桌面连接器的 codex_create/attach/send/read/interrupt；稳定 operationId 在请求前持久化，结果未知查询原操作，不换键重发。SSE 游标和待投递事件持久化，成功、失败、取消、中断与待输入回到原工作。原桌面登录/审批仍按连接器实际能力处理，不引入旧 app-server 后端。

既有 routines 调度可绑定工作与 watch 条件；同职责在途合并，前台优先，有明确观察源时无变化不调用模型。无 watch 的显式定时语义职责按约定时间执行。群聊未 @ 不全员唤醒；明确来源/工作直达，必要时由普通成员做一次只读语义路由。

Markdown 目录和 Skill 描述可检索，正文按需读取；维护可修改 Bot 自己的 Skill。新介绍的私有工具入口会进入相关工作知识；长期授权单独按用户要求判定，凭据继续放既有私有配置。网页长期记忆编辑写同一份 Markdown。

## 运行结果说明

只报告实际执行的操作和结果，未执行的事项不写通过。此前测试、模型调用、浏览器及安装记录保留在 [VERIFICATION.md](VERIFICATION.md)，其中的未验证项不构成后续开发待办，不自动补跑。
