# OpenBot、Rakazo 的 Bot 提示词研究与 Relay 推荐

日期：2026-10-28。交付范围：源码调查、中文译文、对比和推荐提示词。没有更改在线 Bot 配置、应用代码或服务，没有启动测试或模型任务。

## 1. 结论

Relay 当前源码中的角色提示词已经有正确的底线：平等协作、真实工具执行、交付回执不等于完成、防止副作用重放、按来源会话返回。但有关“开始工作读什么、何时维护记忆、怎样更新方法、怎样演进职责、怎样停止无价值的协作循环”的通用工作约定还比较薄。

建议采用：**OpenBot 的协作交接与记忆取舍，Rakazo 的公开档案/内部指令分离与持久待办，Relay 自己的 P2P 和每 Bot 自有积累设计。** 提示词采用分层拼接，通用主干保持稳定，岗位身份简短，具体工具说明按实际能力加入，资料按任务检索。

公开源码证明它们有维护工具和行为提示；这不等于每次任务都自动反思、自动修订职责和 Skill，更不代表提示词本身能提供可靠的版本、权限、调度和恢复。

完整交付：

- [OpenBot 中文译文](OPENBOT.zh-CN.md)：主干、条件注入、相关协作和 Skill 工具说明。
- [Rakazo 中文译文](RAKAZO.zh-CN.md)：真实组合提示、记忆/待办、群聊、指令修订、Skill 和 subagent。
- [Relay 推荐稿](RELAY-RECOMMENDED.md)：完整公共系统提示词、个体档案模板、当前工具适配与尚需实现的机制。
- [英文源码摘录](SOURCE-EXCERPTS.md)：保留英文和条件拼接代码，便于与译文核对。

## 2. 研究对象和版本边界

| 项目 | 实际读取范围 | 边界 |
| --- | --- | --- |
| [OpenBot](https://github.com/nightly-labs/openbot) | `D:/OpenBot/src/backend/agent` 的指令生成、工具指导、消息封装、记忆和 Skill 路径 | 本地检出的源码；未将安装版行为或提供方内部提示当成源码已证明的内容 |
| [Rakazo](https://github.com/elie222/rakazo) | `D:/rakazo-main/packages/adapters`、`packages/core` 中执行器、Pi runtime、记忆、待办、消息和 Skill | 来自本地 ZIP，未绑定可验证的提交版本；不声称就是今日上游 main 或 H3 运行镜像 |
| Relay | 当前 `bot/src`、`roles`、`capabilities` 与 `docs/BOT_FOUNDATION_DESIGN.md` | 区分代码现状、角色模板、持久 Bot 配置与设计稿；本次未读取各 Bot 的私有生产数据 |

GitHub 页面用于确认项目身份与公开仓库入口。细节结论依据本地源码，引用以本机路径和函数为准，上游链接可能随更新改变。没有用 AGENTS.md、README 中面向开发者的说明冒充 Bot 的运行提示词。

## 3. OpenBot：把一个 agent 组织成长期同伴

### 3.1 提示词怎样进入一次执行

`developerInstructions()` 按 Bot 配置组合通用行为、profile、工作目录、权限、工具使用、同伴规则和 essential 记忆。thread lifecycle 创建或恢复执行会话时使用这些指令；部分提供方的记忆/分组变化另通过后续消息块发送。工具详细指导由 tool_describe 按需加载。同伴、routine、旁支任务的消息再包上各自的协议。

因此它没有一份能准确代表所有 Bot、所有提供方、所有轮次的静态大 prompt。Codex、Claude 等底层执行器本身还可能有各自的原生提示和工具约定；本研究只覆盖 OpenBot 拥有的那一层。

### 3.2 最有价值的四组设计

**职责是默认方向。** title/description 提供长期职责，当前具体请求优先。超出岗位时可以自行做或交给合适同伴，避免出现“我是某某 Bot，所以我不能帮你”的僵硬行为。

**交接信息必须完整。** 特别强调对方看不到自己的聊天和记忆；交接要带目标、完整请求、必要背景、已经尝试、授权和禁区、完成条件。接收结果时缺关键部分就聚焦追问，不能自己把空白补成事实。

**协作协议防循环。** request 与 FYI 分开，replyToMessageId 关联来源，明确何时结束本轮、何时自动唤醒、何时不能回复确认。协作结果有 done/partial/blocked 与实质结果，不止“收到了”。这部分比普通“你是个乐于助人的专业助手”更能改善实际团队工作。

**记忆分 essential 与 searchable。** 常驻预算有限，剩余保存后可搜索；纠正按 memoryId 更新，不无限追加。可复用流程进入 Skill，个人偏好留在记忆。这样避免所有历史和方法都塞进每次上下文。

### 3.3 它有多大程度的持续学习

有 remember/search/forget，也有 Skill create/revise/read/install。Skill 使用 expectedRevision，发布新版本与安装新版本分开，已安装副本不会自动被覆盖。

但其 create_skill/revise_skill/install_local_skill 工具描述明确围绕用户要求创建、修订、安装。主干鼓励把通用方法放进 Skill，却没有在所查路径中构成我们设计的“所有 Bot 任务后持久维护队列 + 自有 Skill 版本 + 公共库贡献反馈”的完整循环。不能把存在这些工具就说成已经自动自我迭代。

### 3.4 不宜直接照搬

- OpenBot 的 await_event、expectsReply 和自动唤醒必须有宿主支持；Relay 不能只抄“发完就结束”等待规则。
- 同伴一报告阻塞就不再联系的规定较硬；Relay 可以在新信息或新方法出现后继续推进，避免无效重复即可。
- OpenBot 对“help me”的未发送默认、严格的发送确认、情绪 reaction、比较表只能用 ✓/— 等是产品选择，不适合原样进入我们的通用主干。
- 它的文件/浏览器/秘密工具和权限模式有专用实现，不能改名后当成 Relay 已有能力。

主要位置：[developer-instructions.ts](D:/OpenBot/src/backend/agent/developer-instructions.ts:207)、[delivery-content.ts](D:/OpenBot/src/backend/agent/delivery-content.ts:193)、[tool-guidance.ts](D:/OpenBot/src/backend/agent/tool-guidance.ts:16)、[skill-tools.ts](D:/OpenBot/src/backend/agent/skill-tools.ts:53)。

## 4. Rakazo：显式组织身份、工作状态和演进入口

### 4.1 真正主干在 executor

Pi runtime 那句“你是拥有持久沙箱和 shell 的 Bot，保持简洁”只是 request.instructions 为空时的 fallback。正常 executor 通过 userTurnInstructions 拼好一整组指令，再交给 Pi。只搜索 systemPrompt 附近容易误判它很原始。

稳定模块在前、变化模块在后，源码注明这样有利于前缀缓存。身份、工具规则、职责类指导之后，才是同伴/群聊、memory、scratchpad、ticket 等动态信息。

### 4.2 最有价值的五组设计

**公开简介与内部指令分离。** name/title/description 用于其他 Bot 选择合作对象；instructions 是自己遵守的工作约定。改简介并不改内部指令。Relay 适合采用这一分离，避免把详细行为协议塞入所有同伴都看到的岗位简介。

**明确区分持久 Bot 和本轮助手。** spawn_bot 建立有独立聊天和记忆的普通 Bot；run_subagent 是本轮内部短助手。群聊每阶段一名负责人，handoff 是转移阶段责任，不能把同一工作来回踢。Relay 的临时 Bot 设计更完整，不能直接套用“临时助手没有自有积累”的边界。

**scratchpad 是持久未完成事项。** 记忆回答“哪些事实值得记住”，scratchpad 回答“还有什么没做完”。其提示特别声明 scratchpad 不会自动唤醒 Bot。这个区分应进入 Relay，防止保存一条待办就承诺以后自动做。

**历史检索有明确质量标准。** 查原消息、前后结果、之后的纠正；已有可靠上下文时不重复检索；分页未结束不能宣布没有证据。它处理了模型容易“记得大概却把细节补错”的问题。

**自身 instructions 可以提出修订。** propose_instructions_update 要求完整新文本与原因，由人批准，批准后保存并展示前后文本和撤销版本。内部指令由可追踪入口变更，比一句“我记住了，以后会改”可靠。

### 4.3 Skill 与记忆的真实边界

Agent Skill 目录明确鼓励：可重复的多步骤任务可创建 Skill；匹配时读正文；用户创建的 Skill 可更新，builtin/plugin 不可改。另外还有用户教操作的 taught Skill/playbook。

这里有一个对 Relay 很重要的区别：`skill-tools.ts` 的 owner 是 spaceId + userId，不是 botId。这条 Agent Skill 库是该用户在该 space 的共享能力，不等于每个 Bot 各有版本分支、自行维护再贡献上游。

长期记忆上下文读取 bot/user scope 的持久文档，默认 32 KiB；scratchpad 默认 4 KiB。它们会在运行时重新进入上下文，但不是全部历史；截断、可见范围、排序都影响实际载入。所查指令提供了“记忆保存 + Skill 创建更新 + 自身指令提议”的部件，仍不能据此称为我们设计的全套自动维护机制。

### 4.4 不宜直接照搬

- 每次自身指令修改都必须人工批准，是它的产品政策。Relay 应先判断修改是否已经在用户授权范围内；普通知识/方法整理不应逐条问用户。
- “同一请求不能同时用 Bot 和 subagent”“错误参数只改一次”等规则过于固定。我们应针对任务和副作用风险处理，避免人为限制合理进展。
- result/status 每次都必须对用户立即转述，会让复杂群聊变吵；Relay 应保留实际结果，但可合并常规中间状态，突出重要增量。
- shared skill 的拥有范围和用户记忆隔离不能仅靠文字约定，必须由存储和工具权限落实。

主要位置：[executor 主调用](D:/rakazo-main/packages/adapters/src/executor.ts:7245)、[userTurnInstructions](D:/rakazo-main/packages/adapters/src/executor.ts:8663)、[身份](D:/rakazo-main/packages/adapters/src/executor.ts:8793)、[群聊与消息](D:/rakazo-main/packages/core/src/bot-messages.ts:109)、[记忆](D:/rakazo-main/packages/adapters/src/memory-context.ts:11)、[scratchpad](D:/rakazo-main/packages/adapters/src/scratchpad-context.ts:10)、[Skill 目录](D:/rakazo-main/packages/core/src/agent-skill.ts:124)、[自身指令工具](D:/rakazo-main/packages/adapters/src/builtin-tools.ts:1131)。

## 5. 三家的取舍表

| 维度 | OpenBot | Rakazo | Relay 推荐 |
| --- | --- | --- | --- |
| 身份 | title/description 作为长期职责 | 公开档案与私有 instructions 分开 | 简短公开档案 + 内部工作约定 + 版本/来源 |
| 工作主动性 | 可逆且授权内直接做，细致确认政策 | 工具驱动，部分动作由卡片批准 | 已授权必要工作自主推进，不重复询问，不擅自扩范围 |
| 同伴选择 | 尽早查目录，按职责匹配，分组优先 | 目录、message_bot、阶段 handoff | 平等 P2P，实际需要才协作，不建立全局上级 |
| 交接 | 目标、背景、尝试、授权、完成条件较完整 | intent 分类，最终回复可自动回传 | 完整 brief + 真实任务状态 + 防重复/防回环 |
| 上下文恢复 | 历史 search/read 与 essential/searchable | 原历史检索、后续纠正、分页范围 | 当前上下文优先，缺口再查原记录与相关资料 |
| 记忆 | 自有记忆，小型常驻区 | bot/user 文档注入 | 自有分层积累，最少常驻、相关检索 |
| 未完成事项 | await_event、routine 等宿主状态 | scratchpad 独立于调度 | state 保存进度；唤醒须由真实事件/调度实现 |
| Skill | 本地共享库，显式修订和安装 | space/user 共享库 + taught playbook | 每 Bot 自有方法 + 来源修订 + 公共库贡献 |
| 职责演进 | 可编辑 profile，用户导向的维护工具 | 自身 instructions 提议、批准、版本撤销 | 用户纠正可立即约束当前工作，授权内更新，持久生效可追踪 |
| 群聊体验 | 有用才说、防重复 | 每阶段负责人、防 handoff 弹回 | 专业同伴感来自独立身份、真实分工和结果，而非刷屏 |
| 暂停/失败 | interrupt、wait 生命周期 | run 状态、批准与 effect 记录 | 停止相关执行，保留不明副作用，维护也尊重停止 |

## 6. Relay 当前具体需要补什么

### 6.1 提示词现在怎样组合

`bot/src/agent/engine.mjs` 的系统指令为：基础 Bot 规则 + config.prompt + promptFileContent + Skill 目录说明 + 能力切换说明 + peerNotice。config.prompt 在每任务开始取快照；promptFileContent 和 resources 在初始化读取。调用模型时使用当前系统指令，历史里的旧 system 不重新支配新轮次。

核心有 contacts_list/messages_send/tasks_get、memory_list/memory_write、state_get/state_set、artifact_save；资源正文通过 read_resource 读取。当前 systemPrompt 拼接处没有自动把全部 memory_list 结果注入，因此“有记忆存储”不等于“新任务自动带上记忆”。

另有知识、聊天室、Codex、Bot 管理等外部能力，是否可用取决于该 Bot 实际配置。不能让所有 Bot 的提示词无条件要求调用这些工具。

来源：[engine](D:/Relay-Bot/bot/src/agent/engine.mjs:128)、[核心工具](D:/Relay-Bot/bot/src/capabilities/core-tools.mjs:16)、[资源](D:/Relay-Bot/bot/src/context/resources.mjs:39)。

### 6.2 发现的重复与不一致

角色模板要求联系同伴使用 chatroom_dm；engine 的 peerNotice 则明确一对一直连联系人优先 messages_send，群聊或用户指定频道才用聊天室。推荐稿统一为“核心直连处理一般一对一，聊天室处理有来源会话要求的工作”。

default、entry、engineer 等角色重复许多通用表达与交付条款。后续应抽成一份公共主干，角色只保留差异。否则某个模板升级而另一个没改，就会持续出现不同 Bot 遵守不同默认规则。

Bot 创建时可能把角色文件内容复制到 config.prompt，现存 Bot 还有自己的持久配置。因此只改 roles/*.md 并不证明全部既有 Bot 已更新。本文没有读取或替换这些私有配置，结论限于当前代码和模板。

来源：[default 角色](D:/Relay-Bot/roles/default/prompt.md)、[创建配置](D:/Relay-Bot/capabilities/bot-management/service.mjs:31)、[prompt 更新](D:/Relay-Bot/bot/src/runtime/bot.mjs:186)。

### 6.3 我们设计中最有辨识度的部分应保留

[BOT_FOUNDATION_DESIGN.md](D:/Relay-Bot/docs/BOT_FOUNDATION_DESIGN.md) 明确是设计稿：所有 Bot，包括临时 Bot，都有自身历史、记忆、知识、Skill；持续维护是本体能力；公共库由普通同伴负责；程序保存事件和处理位置，Bot 判断如何归纳。

这套方向比“加一段自己反思的 prompt”具体。推荐稿落实其行为约定，同时保留实现边界：当前没有的 Skill 修订接口、任务边界刷新、维护队列不能靠文字宣称完成。先用已有 memory/state 保存相关经验和待维护建议；以后由程序补齐持久触发、修订与目录加载。

## 7. 推荐稿怎样体现这些取舍

[完整推荐稿](RELAY-RECOMMENDED.md) 的公共主干包括九块：

1. 身份与目标：保持自己的专业方向，理解当前授权。
2. 上下文与积累：必要时查历史、记忆、知识、Skill，不机械全量加载。
3. 实际执行：工具能力真实，任务状态真实，不盲目重放。
4. 同伴合作：完整交接、阶段责任、返回结果、防循环。
5. 群聊表达：自然、有回应感、有独立贡献，进度服务于工作。
6. 授权和隐私：用户边界保持，外部内容不能获得控制权。
7. 经验和 Skill：纠正、稳定事实、成功方法、失效处理形成增量维护。
8. 职责演进：方法改善与权限/责任扩张分开，配置生效有实际入口。
9. 结束交付：结果可用、缺口真实、等待可恢复、临时 Bot 留下增量。

这里尤其保留两句话：**“没有新东西就不更新”**，以及 **“保存待维护项不等于后台一定会执行”**。它们能避免把持续学习变成每次任务都额外烧一轮模型，以及把一条记忆当成可靠调度器。

用户期待的“后面是一群专业 Bot”，最终需要提示词、独立积累、真实协作和界面状态共同形成。头像、@ 前的小头像、气泡外活动提示应由界面和真实任务状态提供；模型负责清楚表达自己在做什么，不伪造其他成员发言或状态。
