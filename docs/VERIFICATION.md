# 验证记录

日期：2026-10-21。验收依据为 [REFACTOR_PLAN.md](REFACTOR_PLAN.md) 第 11 节。当前R9已安装并由StartupHub运行，包含日志轮转、上下文压缩适配层测试、服务关闭身份握手及前台监督修复；完整回归187/187通过、0跳过，另有测试目录回收5/5通过。安装包启停、真实角色工具调用、本地/公网HTTP和SSE复验及浏览器正常刷新后同步通过。原43项旧路径及后续9项已清除，新增98项收尾清单仍待手动处理，Git交付结果单独记录于git-delivery.json，整体目标尚不能标为全部完成。

模型协议 fixture 验证本地机制；真实 Pi、HTTP、SQLite 和子进程不等于真实外部模型调用。下文分别标明自动化、真实 DeepSeek、真实 Codex、迁移及现场界面证据。

## 结果时间线

收尾复查（2026-10-21，Asia/Shanghai）：用户手动运行清理脚本，14:46:24生成成功结果，原43项旧路径及后续9项目标全部不存在。同时发现R8前台监督在14:30:02遇到服务身份不确定后退出；PowerShell事件4100/4575850及403/9900182证明了退出链条，但没有保留底层握手失败类型。入口/聊天室两个Pi进程仍存活，恢复原StartupHub后再次完成真实工具任务。新增监督实现保留未知状态、按间隔复查且不启动副本；可恢复诊断写stdout避免PS5将stderr作为致命错误。定向7/7、完整回归187/187通过，另补运行测试临时目录回收后5/5通过；包含这些修复的R9已完成安装包启停，随后由原StartupHub于14:58:34冷启动并保持Running。

本轮两次未限文件并发的完整测试分别186/187、184/187，保留于supervision-fixed-tests.log、supervision-final-tests.log；失败涉及真实CLI就绪或身份握手超时，不能计通过。测试机availableParallelism=12，测试文件还会创建多个真实子进程，现完整30文件统一并发4，全部187项通过（supervision-bounded-tests.log，36.3秒）。没有跳过用例或放宽产品握手。日志测试teardown仅对未知/暂态重新核验，重试预算20秒，保留确证失败；运行测试在全部Bot关闭后回收本次创建的目录，避免持续留下测试临时数据。此前失败遗留的服务已按真实身份正常关闭，不强杀未知进程。

| 检查 | 已观察到的结果 | 限制或后续状态 |
| --- | --- | --- |
| 重构前工作区基线 | 229/229，baseline-tests.log | 仅为迁移前基线，不替代新架构验收 |
| 新架构收尾前全套 | 147/147，final-tests.log | 对应当时源码，不覆盖之后发现的问题 |
| 删除旧源码后的全套 | 146/147，post-cleanup-tests.log | 独立进程生命周期测试约17秒时报身份握手结束但无响应，暴露真实关闭竞态 |
| 关闭竞态修复 | 最初6项身份握手回归，后补实际CLI退出回归，共新增7项；修复后全套154/154通过，约35.5秒 | post-cleanup-fixed-tests.log保留结果；关闭时收尾已接收连接，短暂EOF/reset重新握手，持续不确定仍拒绝判断为停止 |
| 生命周期测试清理诊断 | 不再吞清理失败；分阶段尽力关闭服务，停止无法确认时保留测试数据；定向1/1通过，9.97秒 | 单项通过不替代修复后的完整回归 |
| Pi上游及来源 | 175通过、2跳过；13/13源文件哈希一致，Pi 1.3.0 | 跳过项需要Anthropic凭据，未计为真实模型通过 |
| 仓库外独立Bot包 | npm pack后安装182个生产依赖，两个CLI独立PID、直接通信、单Bot停止后另一Bot继续 | 外部模型为明确标注的协议fixture；未依赖工作区链接 |
| 隔离真实DeepSeek | 4个完成任务、9次已审计工具调用；入口、聊天室、分身、记忆角色真实执行 | 独立隔离运行，不代替所有角色长期运行验收 |
| 真实Codex app-server | 实际写读59字节文件，内容精确匹配，thread/turn与执行事件关联完整 | 真实任务验证创建/执行/结果；取消、恢复、超时另由fixture验证 |
| R6现场角色与HTTP | 入口、聊天室各完成真实DeepSeek只读工具任务；8个配置均以独立Pi进程初始化；本地/公网状态、增量和两项历史下载完成 | 初始化不等于8个角色都调用过模型；6个原先未运行的Bot已恢复停止 |
| 在线母体与分身 | 3个真实Pi任务、7次DeepSeek请求、4次工具；子工具等待期间母体完成新事件和记忆写入 | 子工具等待gate为受控HTTP测试夹具，模型为真实DeepSeek；所有隔离进程已正常关闭 |
| 追加完成审计 | 发现方案要求的日志轮转尚未实现，以及Relay上下文压缩适配层缺少直接测试；补实现/测试后完整回归172/172通过，约26.9秒 | post-audit-tests.log；新增13项日志/启动回归与5项上下文测试，均未跳过 |
| 服务关闭修复 | R6停止时曾返回Incomplete service identity；随后确认服务已停并恢复R6。修复握手排空和有限重试后完整回归180/180通过，约24.3秒 | service-stop-race.json、recovered-r6.json、service-lock-fixed-tests.log；新增7项真实服务锁测试及1项全新数据根迁移测试 |
| 历史R8安装运行 | 16110文件清单校验通过；安装包Start/Stop正常返回且OS身份确认停止，随后由原StartupHub冷启动。入口/聊天室真实DeepSeek工具任务完成；8实例独立Pi初始化、6实例恢复停止 | 源码来自已提交的aa29c6c，sourceDirty=false；HTTP及SSE本地/公网通过；之后发现上述监督退出问题，不能以此前通过掩盖 |
| 当前R9安装运行 | 16111文件清单校验通过；从D:/执行安装包Start/Stop通过，原StartupHub于14:58:34冷启动。入口/聊天室各完成真实DeepSeek工具任务；8实例独立Pi初始化、6实例恢复停止 | 源码6b11c64e5b4f07d2ea15304995394a13a0536e3b，sourceDirty=false；本地/公网HTTP和SSE、浏览器正常刷新后同步通过；不计为自动重连恢复通过 |

## 证据索引

现场证据根：`D:/Relay-Bot-data/verification/refactor-20261021/`。运行证据保存在数据根，源码提交不包含生产数据库、私有历史或凭据。

| 标识 | 文件或入口 | 内容 |
| --- | --- | --- |
| E01 | baseline-tests.log、new-tests.log、final-tests.log、post-cleanup-tests.log、post-cleanup-fixed-tests.log | 分阶段日志；保留关闭竞态失败及修复后154/154通过 |
| E02 | bot-package.json、pi-source.log、upstream-tests.log | 仓库外安装、独立进程/P2P、固定Pi来源与上游结果 |
| E03 | live-2026-10-21T04-41-09-870Z-e5aae9f9.json；tests/live.mjs | 隔离真实DeepSeek、工具、独立PID、分身、离线交付与合并 |
| E04 | codex-live-2026-10-21T04-42-03-382Z/report.json；tests/codex.live.mjs | 真实Codex、实际文件、会话关联、执行事件与哈希 |
| E05 | D:/Relay-Bot-data/migration/layout-v2.json | 迁移来源/目标、原始ID、逐项文件及行级哈希读回 |
| E06 | deployed-bots.json、deployed-instances.json、deployed-r6-http.json；deployed-http.json保留R5记录 | R6真实角色任务、8个Pi初始化、HTTP/SSE、历史产物与附件校验 |
| E07 | browser-version.png | 本机浏览器界面2026.10.21.1、原历史与8个成员可见；不是手机真机证据 |
| E08 | cleanup-plan.json、cleanup-result.json、cleanup-final.ps1、cleanup-final-result.json | 用户手动清理于14:46:24完成，原43项旧路径及后续9项目标均已不存在；保留Git、有效数据及当时活动R8，未创建备份。这份结果不覆盖之后新增的98项收尾清单 |
| E09 | clone-online-2026-10-21T05-23-27-785Z-71d98125.json；tests/clone-online.live.mjs | 在线母体与分身并发、事件接收、记忆隔离、正常关闭 |
| E10 | final-deployment.json、git-delivery.json | final-deployment已更新为R9发行哈希、真实服务身份、StartupHub及现场汇总；git-delivery单独记录本地HEAD、origin/main和远程SHA核对，避免将文件自身提交号写入文件 |
| E11 | post-audit-tests.log；bot/test/process-log.test.mjs、tests/process-log.test.mjs、bot/test/context.test.mjs | 追加审计后的172/172；真实子进程日志轮转、容量/保留期、启动错误与上下文适配完整路径 |
| E12 | bot-package-r7.json；package-r7/installed-tests.log、smoke-result.json | 日志补齐后的221文件独立包，仓库外安装182个生产依赖；21/21安装后定向测试及两个独立CLI直接通信通过，明确模型fixture |
| E13 | service-lock-fixed-tests.log；tests/service-lock.test.mjs、tests/migration.test.mjs | 完整180/180；服务身份绝对2秒握手期限、最多3次握手、未知身份拒绝判停、250ms回复排空及幂等关闭；全新目标根迁移及只读预览 |
| E14 | build-r8.json、install-r8.json、verify-r8-installed.json、start-r8-manual.json、stop-r8-manual.json、stopped-r8.json、startup-r8.json | 历史R8构建/安装校验、安装包启停与原计划任务冷启动；已由R9替代 |
| E15 | deployed-r8-bots.json、deployed-r8-instances.json、deployed-r8-http.json、deployed-r8-sse-local.json、deployed-r8-sse-public.json、browser-r8.json、browser-r8.png | 历史R8真实DeepSeek两任务、8实例初始化、本地/公网同步与SSE；浏览器正常刷新后的历史和8角色 |
| E16 | startup-r8-exit-diagnosis.json、supervision-fixed-tests.log、deployed-after-cleanup-bots.json；tests/supervise.test.mjs | R8前台监督退出事件、未知身份保留/恢复、信号幂等、真实PS5合并输出回归及恢复后原Pi实例真实工具任务；底层握手原因未确定 |
| E17 | supervision-final-tests.log、supervision-bounded-tests.log、runtime-fixture-cleanup-tests.log、cleanup-final-result.json | 未限并发失败保留；并发4的完整187/187和临时目录回收5/5；用户实际完成原9项目标清理，随后读回确认 |
| E18 | build-r9.json、install-r9.json、verify-r9-installed.json、start-r9-manual.json、stopped-r9.json、startup-r9.json；deployed-r9-bots.json、deployed-r9-instances.json、deployed-r9-http.json、deployed-r9-sse-local.json、deployed-r9-sse-public.json、browser-r9.json、browser-r9.png；final-deployment.json | 当前R9安装包启停、16111文件校验、原计划任务冷启动、2个真实模型任务、8个Pi初始化及6个恢复停止、HTTP/SSE与正常刷新后的浏览器；汇总时270项源码文件0差异，发生在本次文档更新前 |
| E19 | cleanup-closeout-plan.json | 新增98项目标：2份R8发行物、2个失败测试目录、93个运行测试目录及空回退根；仅为待手动处理的计划，执行策略拒绝删除，尚无完成结果 |

## Bot本体和能力：B01–B10

| ID | 对应测试与证据 | 已证明的范围与限制 |
| --- | --- | --- |
| B01 独立package | E02；bot/test/runtime.test.mjs、remote-tools.test.mjs | 仓库外安装后通过公共入口启动，无workspace模块链接；真实CLI使用独立Pi核心。独立包证据不替代整体发行物最终验收 |
| B02 独立身份和上下文 | E02、E03；capabilities/test/lifecycle.test.mjs、bot/test/runtime.test.mjs | 两个CLI及真实入口/聊天室拥有不同PID、数据目录、身份令牌和会话，Pi引擎可观测 |
| B03 基础设施角色 | E03、E06、E18；tests/live.mjs、web/test/server.test.mjs | R9入口实际调用bots_list，聊天室实际调用chatroom_list，独立Pi与真实用量已记录。Web仅转发，关闭Web不关闭网关 |
| B04 状态与长工具 | bot/test/lifecycle.test.mjs、runtime.test.mjs、identity-lock.test.mjs；E01 | 长HTTP工具期间health/messages仍响应，取消、等待与状态可观察。关闭握手曾失败，修复后新增7项回归并完成全套154/154 |
| B05 上下文与历史 | bot/test/context.test.mjs、store.test.mjs、runtime.test.mjs、capabilities/test/chatroom.test.mjs；E02、E05 | 新增5项Relay适配层测试：超限触发摘要、checkpoint持久化、重开数据库后重建模型视图、完整原文分页检索与会话隔离；失败/过长摘要/超大当前输入/并发新历史均不覆盖原文。摘要供应商是显式fixture，SQLite、Pi压缩与Relay适配层为真实代码；不是新的真实模型验收 |
| B06 P2P与回流 | E02；bot/test/runtime.test.mjs、capabilities/test/chatroom.test.mjs、tests/installation.test.mjs | 无Web的独立CLI实际直接通信，发送方停止后接收方继续；另测Web停机不影响网关。群去重、回流、协作跳数、深聊轮数有确定性测试 |
| B07 API/MCP/Skill | bot/test/remote-tools.test.mjs、runtime.test.mjs、capabilities/test/gateway.test.mjs；E03 | 配置式HTTP工具、真实MCP stdio子进程和官方SDK Streamable HTTP通过；Skill显式加载、工具调用可追溯；真实DeepSeek实际调用HTTP能力 |
| B08 原工具行为 | capabilities/test/filesystem.test.mjs、gateway.test.mjs、web/test/attachment-ui.test.mjs、artifact-ui.test.mjs；E04、E06 | 实际写读、搜索、精确编辑、UTF-8命令、真实子进程取消、路径边界、完整输出及迁移后下载验证 |
| B09 去重/未知副作用 | bot/test/store.test.mjs、registry.test.mjs、lifecycle.test.mjs、runtime.test.mjs；capabilities/test/gateway.test.mjs | 重复收据、崩溃恢复、未知效果不重放、排队任务关闭中断、SSE续接；系统停机先拒绝新写入和调度，排空投递后停Bot，防止重新启动 |
| B10 Codex | E04；capabilities/test/codex.test.mjs、gateway.test.mjs | 真实app-server完成文件任务并保存thread/turn；fixture分别覆盖提交去重、查询、取消、恢复、超时、咨询和用户问题；用户授权问题保持待用户答复 |

## 外部分身与记忆：F01–F05

| ID | 对应测试与证据 | 已证明的范围与限制 |
| --- | --- | --- |
| F01 外部复制 | capabilities/test/management.test.mjs、lifecycle.test.mjs；E03 | 外部管理从一致逻辑快照继承会话/记忆，生成新身份、令牌和独立可写数据；不复制任务、收发件箱、PID或在途动作 |
| F02 分身独立执行 | E03、E09；capabilities/test/lifecycle.test.mjs、bot/test/lifecycle.test.mjs | 子Pi真实工具等待期间，在线母Pi于05:23:35.169Z完成新事件和自身记忆写入；控制器35.252Z才释放gate，子36.882Z完成。母体PID/boot未变，母子新增记忆互不覆盖、继承基准不变 |
| F03 增量合并与冲突 | capabilities/test/management.test.mjs、bot/test/store.test.mjs；E03 | 母体并发修改形成冲突，基准/双方内容保留；显式解决后普通revision/CAS写入，重复合并不增修订。真实记忆角色完成一例无冲突增量合并 |
| F04 母体离线交付 | E03；capabilities/test/management.test.mjs | 母体离线时成果/记忆增量/产物独立持久化；分身退出归档后，记忆角色仍可通过普通记忆接口合并到离线母体 |
| F05 回收与引用 | E03；capabilities/test/management.test.mjs、maintenance.test.mjs | 未持久交付禁止回收；归档保留原产物和交付副本，哈希一致；不删除外部项目或复制重放在途任务 |

## 数据、迁移与清理：D01–D04

| ID | 对应测试与证据 | 已证明的范围与限制 |
| --- | --- | --- |
| D01 程序/数据隔离 | tests/installation.test.mjs、capabilities/test/management.test.mjs、filesystem.test.mjs；E05、E10、E11 | 安装拒绝重叠程序/数据根；每Bot私有数据、共享能力库、受管tmp分开。追加日志轮转：默认10MiB/文件、最多5文件、7天保留；UTF-8大块写入、最后写入时间保留期、闲置清理、父进程退出后继续记录、重复启动保护均有真实子进程验证 |
| D02 安全清理tmp | capabilities/test/maintenance.test.mjs、bot/test/maintenance.test.mjs、runtime.test.mjs | 全程持有Bot同一OS所有权租约，拒绝活动身份、未知/中断任务、外部未完成工作；无10,000条分页截断；拒绝junction越界，保留成果和外部工作区 |
| D03 真实迁移 | E05、E06；tests/migration.test.mjs、bot/test/store.test.mjs | **348条逻辑记录；2,353条来源到目标文件映射，对应1,194个唯一目标文件；598项行级及原生记录读回校验。** 口径不同，不能写成2,353个唯一目标文件或598条业务记录。verification.verified=true，文件按SHA256读回，未确认旧任务中断且不自动重放 |
| D04 旧路径清理 | E08、E19、post-cleanup-fixed-tests.log | 根src/public/bots/adapters/templates/test/third_party/.relay、旧脚本/冲突文档、旧data legacy/instances/backups、dist/current及previous已清除；新源码没有活动旧路径导入。原43项及后续9项清理已完成；新增98项收尾清单待手动处理，D04尚未完全关闭 |

R5迁移后本地及公网实际下载结果，见E06：

| 内容 | 实际结果 | SHA256 |
| --- | --- | --- |
| 历史工具产物6a70eac7-7be1-41fa-aa79-a36ad0ae3f80 | 两端HTTP 200，90,000字节，三段ID所有权下载有效 | 46ad476f7a3f3a57c07a061adf5f91bfa94c14595dce61b67b4bada43631b591 |
| 历史附件848dfc17-111b-44f5-b042-a40826ff80d9 | 两端HTTP 200，713,784字节，与迁入文件相同；公网首次60秒超时，单独重试**12.4秒**成功 | a3ad8b2cd59af5a8efd6040c48eb439ff57500090342fe67767dcf6249823f2e |

公网首次超时保留在报告请求及attempts中，不能写成所有请求首次均通过。迁移报告同时记录automaticReplay=false、backupCreated=false。

## 发行、界面和Git：R01–R03、U01–U02、G01

| ID | 对应测试与证据 | 已证明的范围与限制 |
| --- | --- | --- |
| R01 不同cwd启动 | E02、E18；tests/installation.test.mjs | R9由StartupHub使用安装根随包Node冷启动；安装包Start/Stop从D:/执行。Web/网关独立PID，8个Bot实例各有独立PID及新安装根Skill路径 |
| R02 manifest/schema/秘密信息 | scripts/build/verify.mjs、tests/migration.test.mjs；E05、E18 | R9共16111文件，安装前后manifest验证；汇总时270项源码文件哈希一致，之后仅补本次验收文档。固定schema；构建排除凭据/数据库/运行日志，无开发目录链接；提交范围仅本次源码和验收文档，不包含数据根或凭据 |
| R03 入口/StartupHub | tests/installation.test.mjs；E18 | R9安装包正常启停后经原计划任务于14:58:34冷启动，Running；复用既有StartupHub入口，固定网关53119。未实际注销后重新登录电脑 |
| U01 主要工作台流程 | web/test/、capabilities/test/chatroom.test.mjs、gateway.test.mjs；E06、E18 | 聊天发送/重试/缓存、群、知识工具、任务、附件、完整产物、增量合并由当前测试覆盖；R9本地/公网返回8 Bots、9房间，浏览器原历史可见。历史下载另见R5/R6证据；截图不证明所有交互均人工验收 |
| U02 浏览器/PWA | E07、E18；web/test/cache-integration.test.mjs、mobile-viewport.test.mjs | R9本机浏览器正常刷新并同步完成后，无断线/同步提示，原历史与8角色可见；更新草稿/缓存和移动视口由自动化覆盖。**自动重连恢复、手机真机PWA安装/升级/离线恢复未验证** |
| G01 提交/远程一致 | E10、当前main提交及最终回复 | 保留.git与既有历史；R9构建来自已提交源码且sourceDirty=false。本轮提交、推送和本地HEAD/origin/main/远程SHA核对结果单独写入git-delivery.json；清理状态单独记录，提交不代表清理已完成 |

R5 HTTP实测中，/api/state、sync=1全量及带cursor增量在本地/公网均为HTTP 200有效JSON，前端RelayCache.applySync成功应用；无变化增量203字节。Web不转发/tools、/mcp、/internal，本轮保持原公网入口/登录方式。

旧PWA曾显示“200但无法读取内容”。随后复核未重现JSON格式或旧缓存协议错误；公网存在慢传及一次超时，切换期间也观察到Cloudflare 502。不能仅凭后续成功断言先前没有故障，也不能将该提示直接归因于后端格式。

R6已对8个真实配置执行start/health并核对Skill路径重定位到新安装根，之后恢复原先未运行的6个Bot为停止、保留入口/聊天室运行。**health=ready只证明Agent初始化，不能算作8个角色都完成真实模型调用。** 实际调用以deployed-bots报告为准。R6复验本地/公网state、reset、delta和两项历史下载均通过，本地SSE收到connected；本轮公网附件14.3秒、完整state14.0秒，无重试。

当前运行发行物：`2026-10-21T06-53-35-041Z-0e06a410`，16111个文件，内容哈希`290588b78d7d48d6ecf25adfb9779a50405a63adb63102045effa41585826d49`。manifest sourceCommit=`6b11c64e5b4f07d2ea15304995394a13a0536e3b`，sourceDirty=false。发行物与现场由E18关联；包内VERIFICATION为构建时快照，本文件继续记录构建后的验证结果，Git交付结果由git-delivery.json记录。

R9入口和聊天室分别完成bots_list、chatroom_list的真实DeepSeek任务；8个配置的独立Pi进程均初始化成功，Skill路径指向R9安装根，之后恢复6个原先未运行实例为停止，保留入口/聊天室。Web PID 44112、网关PID 60800、入口PID 38028、聊天室PID 98160为06:59Z附近的现场快照，后续重启可能变化。07:03Z汇总确认仅入口/聊天室为ready，4个活动进程日志均包含本次bootId，容量在10MiB配置上限以内。

R9本地/公网state、sync reset、delta均为HTTP 200有效JSON，8 Bots、9房间，RelayCache.applySync成功；无变化增量203字节。本地耗时分别0.204秒、0.158秒、0.170秒，公网7.590秒、6.626秒、2.835秒。SSE本地59毫秒收到connected、18.063秒收到心跳；公网1.444秒、18.313秒；均无失败或重试，SSE未压缩。浏览器刷新前仍显示断线提示，正常刷新同步后提示消失，原历史与8角色可见；这不证明自动重连恢复。

## 剩余清理与未执行验证

服务锁联合测试曾因负载下启动耗时5.88秒超过测试自设的5秒速度断言失败。该断言不属于产品SLO，现改为30秒测试期限并继续断言具体初始化错误和OS锁释放；Bot管理器正常就绪超时为60秒，因此仍验证错误提前返回。该阶段180/180通过，没有跳过失败项。未安装的R7仅含日志补齐，R8及当前R9均包含服务锁修复。

追加审计中，服务日志集成测试曾出现一次整个Node测试子进程提前退出，只报告test failed，没有单项异常或堆栈；根因尚未确定。随后同范围联合测试通过，由主控运行的完整回归172/172、后续180/180及仓库外安装后21/21通过，没有跳过失败项。失败测试创建的原3个临时目录曾受删除策略限制，已纳入用户14:46:24完成的9项清理。当前R9包含日志管理并现场运行。

- 自动审批曾多次拒绝旧回退、旧发行物及失败测试目录删除，仅返回“blocked by policy”，未给更具体原因；代理未绕过限制。用户已手动完成原43项旧路径及后续9项清理，不能继续把它们列为待清理。
- 新增cleanup-closeout-plan.json共98项目标：2份被R9替代的R8源码/安装发行物、2个失败测试目录、93个运行测试目录（pi 21、lease 12、peer 21、history 18、crash 21）及空回退根。此清单仍待手动处理，受执行策略限制，尚无执行完成报告；计划中的路径和身份检查不等于已删除，执行前仍须重新核验保护范围和进程引用。
- 手机真机PWA安装/更新/离线恢复、电脑注销后重新登录的自动启动，以及浏览器自动重连恢复均未验证。正常刷新后的恢复不能替代自动重连验收。
- R9现场汇总已经生成；Git交付结果另见git-delivery.json，清理未完成不因代码推送而关闭。

上述限制不能用历史通过数、fixture、进程存在、静态截图或计划文件替代。
