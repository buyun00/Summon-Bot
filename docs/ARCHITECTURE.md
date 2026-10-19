# 独立精简底座与实现方案

日期：2026-10-18。本文记录建设决策；实时完成状态只记录在 `DEVELOPMENT.md`。

## 1. 本次范围与优先级

Relay 自己持有长期身份、真实共享消息、工作委托与项目知识。Hermes 是源码参考和未来可选 Adapter，不是宿主，不从 Bot Mode 目录抽出一个所谓独立内核，也不维护长期裁剪分支。

用户是唯一最终权威。所有 Bot 平级；调度器只负责存储、投递和队列，没有负责分工或裁决的中央智能主控。首版预置工程、组件、质量三个成员，职责和 Profile 可编辑，也可新增成员。

本次用户指令优先于 `PROJECT_GOALS.md` 的早期建议：首版以能跑、能用为先，不建设权限体系、复杂认证、审批链、环节或文件哈希验证、门禁对比、重复一致性检查、插件市场或分布式服务。原文相关建议移到将来按实际需要评估，不作为首版必需项。只保留消息标识、必要去重、有限的自动回复轮数、超时和异常记录。

## 2. 技术默认值

- Node.js 24（本机实测 24.15.0），原生 HTTP、fetch、子进程、`node:sqlite`；从 2026-10-19 起引入固定版本 pi-agent-core/pi-ai，承担 Bot 自主工具循环。
- 一个仅监听 `127.0.0.1` 的服务，默认端口 8787；一个 `.relay/relay.sqlite` 数据库，SQLite WAL 模式。原生 HTML/CSS/JavaScript 工作台，通过 API 和 SSE 刷新。
- 社交统一使用 `deepseek-flash`，快聊关闭 thinking，深聊启用 thinking。模型调用失败直接记录错误，不生成替代的假 Bot 回答。
- 凭据先读进程环境，再读本地 `.env`，再只读已有 Hermes `.env`；必要时使用用户给定的 `ds.txt`。只在进程内使用，绝不进数据库、文档、日志或 Git。Hermes 可卸载：复制自己的密钥到本项目忽略的 `.env` 即可独立运行。
- Codex 是专业执行端，模型沿用本机 Codex 配置；当前架构规划对话的 Astra Ultra 与社交 Flash 配置无关。
- 默认工作目录为本仓库；用户可以在委托中指定已有目录。每个工作目录一次只运行一份专业委托，避免同目录同时写入；不创建新的工作树或分支，不主动提交、推送、发布。
- 不安装、不构建 Hermes，不启动 H3 新容器，也不修改其他 Hermes 服务。

## 3. 模块与职责

| 模块 | 本次自行建设 | 参考与外部边界 |
| --- | --- | --- |
| Store | Profile、房间和成员、消息、记忆、知识实体/关系、职责、工作与事件记录 | SQLite 是唯一业务状态来源，运行日志不再维护另一套状态 |
| Social Runtime | 按成员唤醒、结构化动作、私聊/多群、深聊、摘要、知识查询与修订、职责 | 借鉴 Hermes 的成员目录/Profile/群与 DM/定时职责体验，不依赖其运行进程 |
| Bot Agent Runtime | pi-agent-core 多轮模型/工具循环、独立执行记录、取消、工具结果与产物 | 每个 Bot 自己读写文件、搜索和执行命令；现有业务动作作为工具复用 |
| DeepSeek client | 密钥加载、真实 API、用量、超时与错误 | 官方 Chat Completions；固定 Flash，不自动切 Pro |
| Codex adapter | 持久工作记录、JSON-RPC 桥接、进度/咨询/结果、取消和显式恢复 | Bot 可按需要委托复杂专业工作；能力以本机协议和真实试验为准 |
| Web 工作台 | 成员、聊天、工作详情、知识与职责的统一入口 | 本地单用户，无账号系统 |

原始参考文件与许可证核查记录见本文第 9 节；不直接复制 Hermes 产品代码，以免带入桌面、共享状态、网关或执行环境依赖。未来若复制，先核查对应文件许可证和传递依赖，并保留声明。

## 4. 三条独立运行通道

快聊、深聊、Codex 工作分别有自己的队列和会话记录。快聊模型请求最多并行 3 次，深聊最多 1 次，专业工作最多 1 次；Bot 等待工具时让出模型请求容量，总在途社交任务最多 12 个。同一房间的单次 Bot 响应按顺序提交，Bot 可以同时在不同房间出现。

新消息先持久化再安排处理。群内成员依据自身职责选择回复或 PASS；被 @ 或私聊的成员优先处理。Bot 可通过结构化动作联系同事、建立深聊、记录记忆或知识、发起工作与设置职责。Bot 消息不会不受限地唤醒整个群：每个根事件保留最多 4 跳自动通信；工作和定时事件各形成新根事件，职责最短 60 秒。重复客户端消息 ID 返回已有消息，模型失败后不自动反复重试。

Bot 发起私聊咨询时，每条请求消息保存 `returnTo`（原房间、原消息、发起 Bot），不把来源挂在可复用的私聊房间上。同事答复按 `replyTo` 精确关联请求，唤醒发起 Bot 在原会话生成答复；只传入该条同事答复，不混入其他请求的私聊记录。回传不再触发普通客套接力；嵌套咨询沿各自请求逐层返回，根事件与跳数上限保留。回传模型 PASS/空回复时明确引用收到的同事原文，调用失败则在原会话显示错误并允许重试。重启补建缺失的回传任务，已有完成、失败或中断记录不自动重做。

深聊房间有目标、成员、来源群和有限轮数，保存独立消息；结束生成有来源的结论或未决说明，写入共享知识并回到来源房间。不会把“多人同意”自动升级为已验证事实。长聊天按较旧消息生成摘要，原始消息保留，后续只取摘要和最近消息。

## 5. 知识与长期身份

每个 Bot 保存名称、职责、专长、提示、启停状态、头像与专业/私人记忆；暂停不会删除历史。头像包含 13 种形状之一、六位颜色和可选的 PNG/JPEG/WebP 数据图片，上传在浏览器压缩，服务端限制大小与格式，图片不进入模型提示词。只填名称即可创建，职责默认“项目协作”，之后在详情编辑。房间与成员关系独立，群名称、目标和成员可修改且保留历史，DM 保持固定双方；进行中或已结束的深聊保留原目标和成员，仅允许更正名称。

记忆与知识支持创建、检索、修订和过期；保存来源、适用版本、状态和修改历史。知识实体和有方向的关系存为关系表，可按词搜索、沿关系查询关联节点。Bot 上下文仅携带相关条目、目录和必要状态；工作日志不会自动灌入聊天。记录可标记为事实、假设、意见、待核查或过期；修订不抹掉旧内容和来源。

## 6. 执行闭环与恢复

### 2026-10-19：Bot 自主操作接入设计（先文档，后实施）

用户授权采用 pi-agent-core，让所有现有及新建 Bot 都能直接使用文件和命令工具，同时保留群聊、深聊、记忆、知识、职责和 Codex 委托。现已按以下设计实施，验收状态只写 DEVELOPMENT.md。

- Relay 继续持有身份、消息、长期记忆和业务状态；pi-agent-core 负责“模型调用 → 工具执行 → 真实结果 → 下一轮模型”的循环。DeepSeek Flash 继续作为模型，摘要等无工具调用保留原接口。
- 每次 Bot 响应建立独立 agent run，以 botId、roomId、jobId 关联；2026-10-19 后续修订引入下节的持久 Session，run 不再意味着重新组装一段独立对话。
- 基础工具为列目录、读文件、文本搜索、写文件、精确编辑和命令执行。Windows 使用 PowerShell；相对路径默认解析到该 Bot 的个人工作目录。另提供明确的共享项目根目录，文件工具校验规范化真实路径，拒绝越界和链接绕过。个人目录按需创建。
- 命令执行是本机用户权限的可信执行能力，cwd 不是操作系统沙箱；本轮不引入容器或复杂审批平台。命令有超时、输出上限、取消与进程树清理；凭据不主动注入子进程或写入执行日志。
- 原 dm/deep/memory/knowledge/relation/routine/work 通过 Relay 工具调用原业务逻辑；专业工作仍进入 Codex 队列，不在 agent 中另造一套委托记录。
- 普通聊天可零工具结束；直接操作在工具结果之后生成最终回复。每个 run 设置轮数/工具数/总时限，长工具等待释放快聊容量。写文件、编辑、命令与 Codex 执行共用本地执行协调，避免同一项目同时被两个执行端修改。
- UI 展示实际工具名、路径、状态和结果，提供取消；失败/中断记录保留。重启把未结束 run/tool 标为 interrupted；显式重试创建新 run 并提供已执行记录，先核对现场，不盲目重放写入和命令。
- 接入固定发布版本，依据安装包实际 API 验证，不依赖 main 分支的未发布签名。自动测试覆盖工具闭环、失败/取消、目录与写入协调、社交动作回归；真实验收在隔离数据库和目录中使用真实 Flash 完成搜索、读取、写入、编辑、命令和读回。

实现落点：`src/agent.mjs` 使用 `@earendil-works/pi-agent-core@1.3.0`；`src/provider.mjs` 用 `pi-ai@1.3.0` 的 transcript/事件类型桥接真实 DeepSeek Chat Completions，HTTP 保持非流式，由 pi 管多轮工具调用。最终仍为兼容 Social 的 JSON 回复；旧动作正文最多校正一次，只有实际工具调用才执行协作动作。`src/agent-tools.mjs` 提供 6 种文件/命令工具，`relay_action`/`search_knowledge` 调用原有业务实现。

个人目录为 `<dataDir>/bots/<botId 的稳定 SHA-256 前24位>/workspace`；路径中的摘要仅用作安全目录名。`protectedRoot=dataDir` 保护自定义运行目录，并检查真实路径。写入先生成同目录临时文件再原子发布并读回；Windows 优先 PowerShell 7（标准安装或 PATH），回退 PowerShell 5 时同样设置 UTF-8 默认值。命令最多 120 秒、输出最多 64 KiB，单文件最多 1 MiB；单 run 默认 16 轮/32 次工具/600 秒。命令非零、取消和超时会作为错误结果交回模型。

`agentRuns` 与 `toolRuns` 为 SQLite 新集合，无需迁移已有记录。工具记录和协作幂等键包含 run、轮次、call ID；跨轮复用 call ID 不会覆盖记录。重试上下文保留全部历史调用摘要，对截断参数显式标记。`src/execution-lock.mjs` 为进程内 FIFO 互斥锁，串行化 Bot 写/编辑/命令和整个 Codex 工作；它不协调用户手动命令、其他 Relay 进程或外部编辑器。

参考：[pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent)、[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。pi 提供运行循环，文件工具、执行协调与持久化由 Relay 实现；不把集成完成等同于真实执行通过。

### 2026-10-19：持久 Session 修订（先文档，后实施）

用户要求同一 Bot 在同一房间连续对话、重启恢复工具上下文，并以真实 API 用量验证缓存。以 `botId + roomId` 为唯一会话键；同一个 Bot 的不同房间、同房间的不同 Bot 分别持有 Session。run 继续记录一次响应的预算、状态、取消和工具结果，关联 sessionId。

- SQLite 新增 `agentSessions`，保存 pi 原生 system/user/assistant/toolResult transcript、已消费房间消息、动态上下文版本及最近 run。每次用 `initialState.messages` 恢复，末尾追加未消费的房间消息和必要的当前任务指令；不再每次把最近24条消息重新包装成整个对话。当前 Bot 自己已经存在于 transcript 中的答复不重复注入。
- 固定 system/tool schema 保持稳定；记忆、检索知识、同事及工作状态变更以尾部增量上下文提供，不能改写已保存的历史前缀。配置变更须明确记录，正确性优先于缓存复用。已存在的旧 run 原生消息在首次创建 Session 时按房间/Bot归属恢复，不能把其他房间内容混入。
- 每个完整消息事件持久保存 Session 与本次 run；工具调用先保存，再执行。取消、异常或重启留下的未配对调用，优先从同 run、同轮次、同调用ID的已保存工具记录恢复真实结果；没有可确认结果时补充明确“结果未确认”的错误观察，不重新执行工具、不伪造成功。中断不自动重发原任务；显式重试或新用户消息才继续。保存的工具结果与调用ID必须成对且可被模型继续读取。
- 同 Session 串行，跨房间保留并发；停止时等待运行任务落盘。重启后已完成会话可以续聊，无需保留常驻 JavaScript Agent 对象。
- 本轮优先完整保留 transcript，不按消息条数滚动丢弃。达到 `agentSessionMaxBytes` 容量时清楚报错并保留原文，默认384000字节（UTF-8 JSON大小，非精确token计数），不静默截断或把摘要冒充完整历史；自动压缩留作单独明确的后续能力。
- 缓存由 DeepSeek 服务端按消息前缀匹配，不能靠 sessionId 保证命中。每次模型请求保存命中/未命中 token 数并区分 run 首次请求与内部工具循环，验收要实际观察连续 run 和重启后首请求的命中情况，不能用单次 run 累计值代替。

实施与验收顺序：先更新本文和 DEVELOPMENT.md；实现持久化、增量上下文与异常恢复；自动验证隔离/顺序/工具成对/取消/迁移/重启；隔离真实模型完成连续文件任务、重启续聊和缓存观察；只提交此范围并推送，手机/PWA/隧道修改保持原样。

### Codex 专业工作

工作包含委托成员、来源房间、目标、工作目录、约束、输入引用、状态、Codex thread/turn ID、时间和独立日志。可运行状态为 queued、running、waiting、completed、failed、cancelled、interrupted。进度通过 SSE 到工作详情；完成后向来源群回传摘要与真实验证结果。单次执行默认总时限 1800 秒，创建 API 可通过 timeoutSeconds 调整（最小 30 秒）；执行与等待咨询共同计时，超时记录 interrupted 并清理本工作进程，保留线程供显式恢复，不自动重试。

优先使用本机 `codex app-server` 的 stdio JSON-RPC；实查 thread/start、thread/resume、turn/start、turn/interrupt 及动态工具协议。中途咨询通过 `relay_consult` 动态工具送给委托 Bot/指定专家，回答后返回原工具调用；无可信答案时保留待答，用户可补答。每个咨询作为消息持久化，不靠解析自由文本猜问号。若实际协议有不支持项，明确收缩接口并记录，不声称支持。

服务重启时 queued 社交事件继续，已运行但没有确认结束的调用标 interrupted，避免自动重做外部写入。未完成 Codex 委托由用户在工作详情点击恢复，使用已保存 thread ID；恢复同一对话不意味着精确恢复某条正在运行的 OS 命令。未答咨询恢复时向执行器说明原中断与已知答案，不能假称原连接还存在。职责保存 nextRunAt，重启只补一次到期执行，不补发所有错过周期。

## 7. API 与文件边界

API 返回 JSON；错误为 `{error}`，缺少记录返回 404，输入问题返回 400。

- `GET /api/state`：bots、rooms、works、routines、knowledge（nodes/edges）、provider、runtime、activity；rooms 附最后一条实际消息，activity 包含真实转交与回传关联，用于界面的会话预览与来源提示。
- `POST /api/bots`、`PATCH /api/bots/:id`；`GET/POST /api/bots/:id/memories`、`PATCH /api/memories/:id`。
- `POST /api/rooms`（name/kind/members/goal/originRoomId）、`PATCH /api/rooms/:id`（name/members/goal）；`GET/POST /api/rooms/:id/messages`（content/toBotId/replyTo/attachments/clientId）；`POST /api/rooms/:id/conclude`。
- `GET /api/knowledge/search?q=&botId=`、`GET /api/knowledge/graph?id=&depth=`；`POST /api/knowledge/nodes`、`PATCH /api/knowledge/nodes/:id`、`POST /api/knowledge/edges`。
- `POST /api/routines`、`PATCH /api/routines/:id`；`POST /api/events`（type/content/roomId/botId）。
- `POST /api/works`（botId/roomId/goal/cwd/constraints/inputRefs）；`GET /api/works/:id`；`POST /api/works/:id/cancel|resume|answer`。
- `GET /api/state` 另含最近 50 条 `agentRuns` 摘要；`GET /api/agent-runs/:id` 返回实际工具记录；`POST /api/agent-runs/:id/cancel` 取消当前执行。聊天中的操作卡按需加载详情，命令输出独立显示并作 HTML 转义。
- `GET /api/stream`：SSE 只通知数据已变化，浏览器重新读取当前视图，避免复杂增量协议。

文件分工：`src/store.mjs` 与 `src/social.mjs` 为社交/存储；`src/agent.mjs`、`src/agent-tools.mjs`、`src/execution-lock.mjs` 为自主操作；`src/codex.mjs` 为专业执行器；`src/config.mjs` 和 `src/provider.mjs` 为环境/模型；`src/server.mjs` 为装配/API；`public/` 为界面；`test/` 为有意义的功能验证。开发状态只维护 `docs/DEVELOPMENT.md`，不另设 progress.json 或重复勾选清单。

### 浏览器动效状态

`public/avatars.js` 保留原13种SVG轮廓，并沿统一192条射线取样，插值轮廓和RGB而非用两个头像淡入冒充变形。`render` 接受 `{key, identity, static, preview, intro}`：key代表稳定展示槽，identity代表Bot，static用于选择器，preview/intro仅用于大预览。`capture/hydrate` 在DOM替换间复用当前插值、速度和表情时钟；图片层只改变透明度。单rAF处理可见头像，后台暂停，脱离节点与闲置身份有界清理，减少动态效果时立即收敛。

`public/motion.js` 负责界面元素进出，不读写业务数据库。app用签名判断无变化刷新，实际变化才替换DOM；新消息按ID跟踪，选择环和消息重挂时延续过渡，退出快照inert且去掉交互与重复ID。头像修改使用按Bot串行的最后选择优先队列，状态读取、图片解码、表单回包均检查操作版本或归属，避免动画即时预览被旧响应覆盖。

## 8. 制作与验证顺序

先落本文与目标修订；再落开发进度；之后才写产品代码。按存储和社交、执行器、工作台并行制作，最后装配运行。

验证分三类记录：本地自动测试（使用明确标记的模型/协议测试替身，只证明程序逻辑）、真实 DeepSeek Flash 请求、真实 Codex 工具与产物。检查快慢并行、用户/成员私聊、多群上下文、深聊产出、知识关联与修订、定时/事件、消息去重、执行咨询/取消/恢复、重启数据和工作状态。正常功能测试不变成每一步审批或门禁。没有实际跑过的 Unity、Figma、设备、发布与长期稳定性不写通过。

## 9. 核查依据

- 本机 `node --version`：v24.15.0；`node:sqlite` 实测 SQLite 3.51.3。
- 本机 `codex --version`：0.156.1；从本机 `app-server generate-ts` 实查到 thread/start、thread/resume、turn/start、turn/steer、turn/interrupt 和消息/命令增量通知。独立 stdio 握手、model/list、read-only ephemeral thread/start 与 relay_consult 动态工具声明已成功；当前执行端默认模型是 gpt-6-astra、reasoningEffort=low。实现阶段的真实工具、取消和恢复证据统一见 DEVELOPMENT.md。动态工具调用使用 item/tool/call 请求，同请求 ID 返回 contentItems/success。每个工作使用自己的 app-server 进程，不控制桌面共享进程。Windows 退出需清理自己启动的进程树和管道。
- DeepSeek 官方 [首次调用](https://api-docs.deepseek.com/quick_start/agent_integrations/) 与 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 于 2026-10-18 核查，支持 `deepseek-flash` 与 thinking 配置。最终连通性以本机实际调用为准。
- Hermes 参考根目录为 `C:\Users\win11\AppData\Local\hermes\hermes-agent-source-incomplete-20261018`。`apps/desktop/src/plugins/hermes-bots/types.ts`、`data.ts`、`profile-ops.ts`、`canonical-chat.ts` 依赖插件 SDK、host RPC 和 Profile/session 存储；`group-chat.ts`、`group-rounds.ts` 可参考单一群日志、游标、PASS 和有限轮数。`tools/bot_mode_probe.py`、`bot_mode_dm.py`、`bot_live_delivery.py` 依赖完整 Hermes 工具循环/CLI/SessionDB；`cron/jobs.py` 与 scheduler 依赖 Hermes home/provider/delivery，首版均不引入。
- Hermes 根 LICENSE 为 MIT（2025 Nous Research），Bot UI 目录 LICENSE 亦 MIT（2026 Nous Research）。本项目选择原创实现，不复制实质代码。
- 2026-10-19 根据用户六张参考截图重新制作 Bot 视觉：浅灰会话栏、彩色形状头像、悬浮标题、气泡与胶囊输入框、右侧详情及创建/头像弹窗。`public/avatars.js` 的几何按参考图原创，11 色按截图色卡取样；未复用 Hermes React/SDK/运行代码。
- 安装包源码位于 `C:\Program Files\WindowsApps\NousResearch.HermesBundled_2026.6864.2132.0_x64__e60prshbsznhj\app\resources\agent-payload\hermes-agent`，manifest ref 为 `e06df9c2eae6901f4c88f464e0ae6e753c0428b8`。已有 Hermes 配置为 deepseek/deepseek-flash，密钥存在；未将密钥写入本项目。密钥存在不等于模型调用已通过。
