<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="88" />

# Summon Bot

**部署在你电脑上的新一代多 Bot 群聊助理：告别单对话混乱与人肉多会话编排，让一群会分工、会纠错、会记事的 AI Bot 替你把活干完，把时间留给自己冲咖啡。**  
**A Next-Gen Local Multi-Bot Group Assistant · Beyond single-thread chaos and manual session juggling — a team of AI Bots that divide work, cross-check, and remember for you, leaving you time to brew your own coffee.**

![Group Chat](https://img.shields.io/badge/Workflow-Multi--Bot_Group_Chat-477A54?style=flat-square)
![Auto Team](https://img.shields.io/badge/EggBot-Auto_Role_Spawning-A87932?style=flat-square)
![Split Layer](https://img.shields.io/badge/Chat_%26_Work-Never_Freezes-597C91?style=flat-square)
![Clients](https://img.shields.io/badge/Clients-Web_%7C_Desktop_%7C_iOS_26_%7C_Android-2C4C66?style=flat-square)

</div>

---

<a id="top"></a>

<details open>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-zh.svg" alt="主控 Bot 引导卡片：点击展开简体中文一镜到底群聊实录、多场景演示与竞品对比导览" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-zh.svg" alt="Summon Bot 连续群聊实录（1 / 3）：从模糊想法聊出航海选路游戏《雾港远征》；01 EggBot 旁听发现每章数值平衡缺专人，无需指令自动 create_bot 孵化 @关卡策划 入群并试算海岸章路线；02 ① 快读层（thinking: off、零写权限）实现无关消息当场 quiet 静默省 90% Token，并在关卡策划想下载 FFmpeg 时由总接口 Bot 免 @ 主动递上本机现成连接 cli-ffmpeg 拦住重复安装。" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-zh.svg" alt="Summon Bot 连续群聊实录（2 / 3）：03 ② 群主对话与 ③ 后台执行会话双层分离，后台并行跑路线存档 CLI 与离线战报 HTML 两路 Codex，平台硬门禁（403 room_send_forbidden）禁止执行器直接刷群，前台照常秒回聊第二章雪原章 frost_streak 冻伤机制；04 随口补充 0 字节 blank.png 与前后两列要求由 ① 快读按 route: forward 原生 steer 秒级塞进在途 Codex，后台工具换版报错由群外专责维护 Bot 静默自修。" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-3-zh.svg" alt="Summon Bot 连续群聊实录（3 / 3）：05 先好的先交（10:06 report.json、10:07 report.html 引用原提问）、试玩反馈秒改单文件战报、稳定主线加本轮私有 Fork 保持 90%+ 缓存命中、五层人格与 material_index_ref 将战报格式永久写入本群约定；06 P2 用途模型表为快读、主对话与独立执行分层配模型与思考档，usage.sqlite 独立记账。" width="100%" /></a>
</p>

---

## 不止能做游戏：在各种真实工作与日常场景里是什么体验？

上面的完整实录以一款小游戏演示了一镜到底全过程，但 Summon Bot 是**通用的多 Bot 群聊工作台**——无论是**网页开发、服务器维护、全栈工程还是个人日程管理**，你都不需要面对十几个黑框终端，也不必提前手写一堆繁琐的角色配置，只管像和真人团队聊天一样把想法抛进群里：

### 1. 网页开发：缺什么专员，群里会自动招什么人

<p align="center">
  <img src="docs/assets/readme-scene-1-zh.svg" alt="网页开发对话实录（官网改版项目群 · 自动招人组队）：你（14:10）：我们要给新产品做一个极简官网，首屏要有实时交互演示，顺带把亮暗双主题和移动端适配也一起做好。｜主控 Bot（14:10）：没问题，Next.js 框架、交互演示组件和部署脚本由我负责。不过视觉规范、亮暗配色 Token 和响应式细节，最好有位专职前端视觉长期把关。｜EggBot（14:11，自动发现职责缺口）：已邀请新成员 @前端视觉 入群，专门负责首屏栅格、亮暗主题与移动端排版。｜前端视觉（14:11）：大家好！我已按极简纸感风格拟好了 3 套首屏栅格与亮暗配色 Token，同步照顾了手机端单列折叠，先发一版给大家定方向？" width="100%" />
</p>

- **不用开局配齐角色模板**：做官网改版、产品原型或内部系统时，你不需要一上来就写完整 PRD 或手动创建四五个角色提示词，像日常讨论一样提出方向即可。
- **EggBot 旁听自动建制**：潜伏在群里的 **EggBot** 会持续跟踪项目进展。一旦聊出长期职责缺口（例如视觉规范、亮暗配色与移动端适配），它无需你下令，就会自动孵化对应专员（`@前端视觉`）拉进群并交接清楚背景。

---

### 2. 服务器维护：平时安静旁听不刷屏，关键时刻免 `@` 主动拦住风险

<p align="center">
  <img src="docs/assets/readme-scene-2-zh.svg" alt="服务器维护对话实录（线上服务运维群 · 静默旁听与免 @ 救场）：你（21:05）：刚收到告警，新加坡节点反向代理报 502 了，先帮我查下最近 10 分钟的 Nginx 错误日志。［快读摘要 · 主控 Bot / EggBot：线上故障日志排查，与代码发版和建制无关，保持静默］｜运维专员（21:06）：定位到了，上游 Node 进程 OOM 重启导致连接断开。我先执行 systemctl restart nginx 并清掉 /var/cache/nginx 缓存目录？｜总接口 Bot（21:06，未被 @ · 主动拦住风险）：先别硬重启和删全量缓存！直接用现成安全运维连接先导出一份堆快照再平滑 reload，保住现场：［🔗 连接 ops-ssh-sg］｜运维专员（21:07）：幸好拦住了！已通过 ops-ssh-sg 导出堆快照并平滑 reload，服务恢复 200，正在排查泄漏点。" width="100%" />
</p>

- **无关成员自动静默，绝不抢话刷屏**：每条消息先经关闭思考的快读层秒级分流。当你让运维专员排查新加坡节点 502 告警时，主控 Bot 和 EggBot 一眼判断与代码发版和建制无关，当场保持安静，只在气泡下方留一行简短的已读摘要。
- **发现隐患免 `@` 主动救场**：当运维专员准备执行硬重启并清空全量 Nginx 缓存时，尽管没有人 `@总接口 Bot`，一直旁听的总接口 Bot 仍会主动站出来拦住高风险操作，并递上现成运维连接 `ops-ssh-sg` 先保住 OOM 堆快照再平滑重载。

---

### 3. 全栈开发：后台多路跑代码和迁移，前台照常秒回聊下一模块

<p align="center">
  <img src="docs/assets/readme-scene-3-zh.svg" alt="全栈开发对话实录（全栈开发协作群 · 聊干双层分离）：你（15:20）：好，那现在开工把用户鉴权 API 迁移到新库，同时把前端登录页和 OAuth 回调联调跑通吧。｜主控 Bot（15:20）：收到，后端迁移脚本与前端登录页改造已拆成两路在后台并行开工。后台写代码不影响我们聊天，趁现在要不要先把下一阶段「安全通知邮件」的字段定了？｜你（15:21）：行，正好不用盯着编译干等！新设备登录提醒要带上登录城市、设备型号和一键下线链接。｜前端视觉（15:21）：明白！我这就把邮件卡片的亮暗两套 HTML 模板和一键安全按钮样式排出来。｜［底部状态条：执行过程（2）· #1 鉴权 API 与数据库迁移（Codex 运行中）｜ #2 登录页与 OAuth 联调（Codex 构建中）· 前台聊天 0 卡顿］" width="100%" />
</p>

- **聊天层与执行层彻底解耦**：普通 AI 编程工具一旦开始跑数据库迁移或前端联调，整个聊天框就会卡住几分钟；在 Summon 群里，“陪你聊天的群成员”和“在后台埋头干重活的 Codex / Pi 执行器”是完全分开的。
- **前台聊天永远不卡顿**：哪怕后台正同时跑着鉴权 API 迁移与 OAuth 登录页联调两路重活，群里依然秒回你的每一句话——当前需求还在后台编译测试，下一阶段的「安全通知邮件」模板已经在群里拍板完毕。

---

### 4. 日程管理与个人事务：随口插话直转在途任务，长期习惯说一遍永久记住

<p align="center">
  <img src="docs/assets/readme-scene-4-zh.svg" alt="日程管理对话实录（个人日程与事务群 · 随口插话直转与习惯落盘）：你（08:42）：对了，刚想起来！周四下午 3 点要和王总碰面，正在排的上海出差行程把虹桥高铁改成 11 点那班，午饭和路程时间留宽裕一点。［快读直转 · 日程助理：周四改 11 点高铁并预留 15:00 会面（已直转在途排程任务，无需重排）］｜日程助理（08:43）：今日待办与待回复客户邮件先整理好了，重点事项已标红；你刚改的高铁与会面已合入行程任务：［📄 today-brief.md］｜日程助理（08:44）：三天上海出差日程也排好了！已切到 11:00 高铁、预留 15:00 与王总会面，可直接导入日历：［📅 shanghai-trip.ics］［📄 trip-plan.md］｜你（08:45）：很顺手！以后我的出差安排默认避开早 8 点前的航班，重要会面前至少留 40 分钟缓冲。［长期习惯已落盘 · 后续每次排差旅与日程自动遵守］" width="100%" />
</p>

- **临时改计划不用推倒重来**：行程表排到一半突然想起周四下午新增客户会面，只需在群里随口补一句，日程助理的快读层毫秒级把变更塞进正在跑的排程线程里，无需按暂停也不用从头再聊。
- **多项事务先好先交**：今日待办与客户邮件摘要先整理完就先交 `today-brief.md`；合入最新高铁与会面时间后的完整三天行程紧接着交付可直接导入手机日历的 `shanghai-trip.ics`。
- **个人习惯说一遍永久记住**：你交代一句“以后出差默认避开早 8 点前航班、重要会面前留 40 分钟缓冲”，群成员会自动将其写入长期习惯，往后每次排差旅与日程自动照办。

---

## 和平时用的 AI 工具相比，体验有什么不同？

### 1. 对比 Codex / Claude Code 等传统 Session 式工具

<p align="center">
  <img src="docs/assets/readme-cmp-codex-zh.svg" alt="对比 01（Summon Bot vs 传统 Session 式工具如 Codex / Claude Code）：传统 Session 工具虽可插话，但极度消耗人的多对话管理与编排精力——同时开 4 个会话极易陷入手动复制上下文的交接漩涡，且单个长目标常因权限弹窗或环境小 Bug 半路停摆；Summon Bot 由主控和专员在统一群聊里自动拆解并并行调度多路 Codex/Pi 后台稳跑、遇到工具小报错群外自动修复，最终复测合并一次交付，让长目标完整无误、高效不中断地跑完。" width="100%" />
</p>

- **解决的不是“能不能插话”，而是“谁来编排与兜底”**：传统 Session 式工具本身也能插话，但一旦任务变复杂，就需要人自己充当多会话编排器——同时盯几个窗口、手动来回贴上下文，极易陷入**多对话交接漩涡**，且一个长目标动辄因为权限卡顿或奇奇怪怪的环境小 Bug 半路中断。
- **群聊统一编排，长目标高效跑完**：Summon Bot 不是取代 Codex，而是把多路 Codex / Pi 作为后台执行引擎交给群主控与专员统一编排。你只管在群里定目标与验收，多路重活自动并行推进、依赖在群内自动对齐、小故障由维护机制后台兜底，不用耗费人的管理精力就能让复杂长任务完整跑通。

---

### 2. 对比 Hermes 等“龙虾类”单对话本地助手

<p align="center">
  <img src="docs/assets/readme-cmp-hermes-zh.svg" alt="对比 02（Summon Bot vs Hermes 等龙虾类单对话本地助手）：单对话助手把聊天、命令执行、报错堆栈、日程和代码全挤在一个窗口里，导致意图混杂、执行混乱且长聊压缩后习惯经常遗忘；Summon Bot 作为部署在你电脑上的新一代个人助理 Agent，通过分群协作与专职 Bot 分工（研发主控、日程事务助理、运维与维护 Bot），并由专职机制自动化沉淀个人习惯、群长期约定与资料经验库，执行更清爽、记忆更顺畅永不遗忘。" width="100%" />
</p>

- **新一代本地个人助理架构**：同样部署在你自己的电脑上，Summon Bot 不再把所有事情塞进唯一一个对话窗口里。按项目和事务分群、由不同专职 Bot 各司其职，彻底告别单对话一锅烩带来的一级混乱与执行串台。
- **专职自动化记忆沉淀，不会忘记**：个人偏好、群长期约定与资料方法索引都由专门的记忆与资料机制自动结构化落盘，跨会话和历史压缩后依然稳定生效，越用越顺手。

---

### 3. 对比 Grokbot / OpenBot 等云端个人助手

<p align="center">
  <img src="docs/assets/readme-cmp-grokbot-zh.svg" alt="对比 03（Summon Bot vs Grokbot / OpenBot 等云端个人助手）：大厂个人 Agent 往往专注在云端虚拟机里尝试对接外卖点咖啡、购物社交等消费级应用，结果变成 AI 帮你点咖啡、真正的代码和重活还得你自己干；Summon Bot 100% 跑在你自己的电脑上，直接读写本地仓库、调用本机工具并混搭已有模型订阅，把真正的活交给 Summon 完成——过上自己慢慢冲咖啡、让 AI 干活的生活。" width="100%" />
</p>

- **专注把真正的活干完，而非云端炫技**：大厂云端个人 Agent 擅长在云端虚拟机里对接消费级应用生态，但很难深度接管你电脑上的真实项目、代码仓库与本地工具链。
- **自己冲咖啡，让 AI 干活**：Summon Bot 100% 本地自托管，直接操作你的本地工作区并自由混搭本机已有的 Codex、Grok、Claude 登录订阅与 DeepSeek 等模型。我们不需要“AI 帮点咖啡、自己苦干重活”，而是把能交给 AI 的活和事务尽量交给 Summon 完成，把生活留给自己慢慢冲咖啡。

---

### 4. 对比 DSH SuperAgent（中心路由式 Agent）

<p align="center">
  <img src="docs/assets/readme-cmp-superagent-zh.svg" alt="对比 04（Summon Bot vs DSH SuperAgent 中心路由式 Agent）：中心路由式架构把需求、代码日志与工具回执全塞进单一中心主 Session 做唯一判断大脑，上下文混杂膨胀、一次误判全盘跑偏，且子 Agent 被动听令无法相互纠错；Summon Bot 采用扁平化同伴协作网络，主控 Bot、领域专员、总接口 Bot 与 EggBot 各自保持干净隔离的上下文，实时旁听并相互纠错，一群臭皮匠稳赢单个诸葛亮。" width="100%" />
</p>

- **扁平化同伴管理，不赌单一对话的判断**：中心路由式 Agent 把所有信息和决策压在一个中心主 Session 上，上下文越积越杂、单点误判就会牵连全局，子 Agent 也只能被动听派单。
- **上下文隔离 + 相互纠错（一群臭皮匠顶几个诸葛亮）**：在 Summon 群里，每位 Bot 都拥有干净隔离的职责上下文与独立记忆，通过快读实时旁听群内动态、发现队友走弯路或有风险时主动开口纠错，让判断更准确、协作流程更顺畅。

---

### 5. 全自研原生四端随时接力

<p align="center">
  <img src="docs/assets/readme-clients-zh.svg" alt="全自研原生四端实时同步（Protocol 3）与 Bloub 纸片几何头像、按用途精细记账：涵盖普通网页（Paper / Midnight）、Electron 桌面端（Win x64 / Mac arm64）、iOS 26 原生客户端（SwiftUI Liquid Glass）与 Android 原生客户端（Jetpack Compose），所有对话与凭据保存在本地电脑，出门拿手机随时查看进度或改行程。" width="100%" />
</p>

- 提供 **普通网页（Paper / Midnight 双主题）**、**Windows / macOS (arm64) Electron 桌面端**、**iOS 26 原生客户端（SwiftUI Liquid Glass）** 与 **Android 原生客户端（Jetpack Compose）**，统一支持 Protocol 3 实时同步、Bloub 纸片几何动画头像与按用途精细记账。电脑上开好工，出门冲杯咖啡、拿手机随时看成品或拍板下一步。

---

### 🗂️ 深入了解与专项文档

如果你想了解背后的架构与部署细节，可以直接查看以下专项文档：

- [系统总体架构 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot 自动组队与 17 种内置岗位 (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [模型路由与执行连接 (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub 纸片几何头像 (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [四端发行与自动更新 (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [部署与日常运维 (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-en.svg" alt="Lead Bot & EggBot Welcome Card: English Edition — Full Walkthrough, Everyday Scenarios & Architecture Comparisons" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-en.svg" alt="Summon Bot Continuous Walkthrough (1 / 3): From a rough single-player game idea to Mistport Expedition; 01 EggBot observes the room, spots a long-term balance ownership gap, calls create_bot to spawn @LevelDesigner who immediately simulates Coast routes; 02 ① Fast-Read layer (thinking: off, zero write access) stays quiet on unrelated turns saving 90% tokens, and Tool Bot proactively steps in without @mention to hand over cli-ffmpeg when LevelDesigner is about to download FFmpeg redundantly." width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-en.svg" alt="Summon Bot Continuous Walkthrough (2 / 3): 03 ② Main Room Chat and ③ Background Execution Sessions are cleanly split—two parallel Codex jobs build the Coast diff CLI and offline HTML report under a code hard gate (403 room_send_forbidden) while chat stays instant to design Chapter 2 Snowfield (frost_streak); 04 Casual mid-build addendum (0-byte blank.png & 2 size columns) is steered via ① Fast-Read route: forward directly into the live Codex thread, and broken CLI tools are silently self-repaired out-of-band by a Maintainer Bot." width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-3-en.svg" alt="Summon Bot Continuous Walkthrough (3 / 3): 05 Staged verified delivery (10:06 report.json, 10:07 report.html quoting the original request), rapid playtest UI tweaks, stable trunk + private fork (90%+ cache hit), and 5-layer persona/material_index_ref persisting room conventions permanently; 06 P2 purpose-based model routing table assigns distinct models and thinking levels to Fast-Read, Main Chat, and Standalone Execution with usage.sqlite accounting." width="100%" /></a>
</p>

---

## Not Just for Games: How Summon Works Across Everyday Projects & Life

The continuous walkthrough above used an indie game as one end-to-end example, but Summon Bot is a **general-purpose multi-Bot group workspace**. Whether you are **building websites, maintaining production servers, running full-stack migrations, or managing daily schedules**, you simply talk to your team in a group chat:

### 1. Web Development: Missing a Specialist? The Room Recruits One Automatically

<p align="center">
  <img src="docs/assets/readme-scene-1-en.svg" alt="Web Dev Dialogue (Website Redesign Room · Auto-Recruiting): You (14:10): We need a minimalist landing page for our new product with a live interactive hero, plus light/dark themes and clean mobile responsiveness. | Lead Bot (14:10): I can own the Next.js app, interactive demo components, and deploy scripts. For visual tokens, dark-mode polish, and mobile grids, a dedicated UI owner will help. | EggBot (14:11, Spotted Role Gap): Invited @UIDesigner to own hero grids, theme tokens, and mobile layout. | UIDesigner (14:11): Hi all! I drafted 3 minimalist hero grids with paired light/dark color tokens and single-column mobile breakpoints—shall I post the first preview?" width="100%" />
</p>

- **Start with an idea, not a YAML roster**: When redesigning a website or launching a web app, you never have to hand-craft five role prompts upfront—just talk through what you want to build.
- **EggBot recruits missing roles on its own**: Quietly observing the room, **EggBot** spots long-term ownership gaps (like visual tokens, dark-mode polish, and mobile breakpoints), spawns `@UIDesigner`, invites her in, and hands off full context automatically.

---

### 2. Server Maintenance: Quiet When Unrelated, Proactive When Risk Appears

<p align="center">
  <img src="docs/assets/readme-scene-2-en.svg" alt="Server Ops Dialogue (Server Ops Room · Quiet Triage & Proactive Rescue): You (21:05): Alert just fired: Singapore reverse proxy is returning 502. Check the last 10m Nginx logs. [Fast-Read · Lead Bot & EggBot: Live incident log triage, unrelated to app code—staying quiet] | Ops Bot (21:06): Found it—upstream Node process OOM-restarted and dropped sockets. Should I run systemctl restart nginx and wipe /var/cache/nginx/* to reset? | Tool Bot (21:06, No @mention · Safety Catch): Hold off on hard restart and cache wipe! Use this ops connection to capture a heap snapshot and run a graceful reload so we keep OOM evidence intact: [🔗 ops-ssh-sg] | Ops Bot (21:07): Good catch! Captured heap dump via ops-ssh-sg and reloaded gracefully—200 OK restored." width="100%" />
</p>

- **Zero chatter on unrelated rooms/tasks**: Every message first passes through a zero-thinking Fast-Read triage layer. When you ask `Ops Bot` to inspect a Singapore 502 outage, Lead Bot and EggBot recognize it doesn't touch app code and stay silent—leaving only a compact 1-line read summary.
- **Proactive safety catch without `@mention`**: Even though nobody tagged `Tool Bot`, the moment it overhears `Ops Bot` proposing a hard Nginx restart and full cache wipe, it steps in on its own with `ops-ssh-sg` so a heap snapshot is preserved and Nginx reloads gracefully.

---

### 3. Full-Stack Engineering: Heavy Migrations Run in Background While You Plan Ahead

<p align="center">
  <img src="docs/assets/readme-scene-3-en.svg" alt="Full-Stack Dev Dialogue (Full-Stack Dev Room · Chat & Work Split): You (15:20): Let us kick off the auth API database migration and wire up the new OAuth login page now. | Lead Bot (15:20): Started both jobs in parallel in the background. Coding will not freeze our chat—want to finalize fields for the next security alert email template while they build? | You (15:21): Yes, love not waiting on builds! Include login city, device model, and a one-click revoke link. | UIDesigner (15:21): On it! Drafting both light and dark HTML email cards with the one-click revoke button. | [Footer status bar: Background Jobs (2) · #1 Auth API & DB Migration (Codex running) | #2 Login UI & OAuth Flow (Codex building) · Zero Chat Freeze]" width="100%" />
</p>

- **Chatting and heavy execution are completely separated**: Unlike single-window coding CLIs that freeze whenever a database migration or frontend build starts, Summon separates foreground group chat from background Codex / Pi execution sessions.
- **Zero chat freeze**: While both the auth API database migration and the OAuth login page build in parallel, the room stays instantly responsive—you finish designing the next security alert email template before the first build even wraps up.

---

### 4. Schedule & Personal Management: Steer Plans Mid-Flight and Keep Habits Forever

<p align="center">
  <img src="docs/assets/readme-scene-4-en.svg" alt="Schedule Management Dialogue (Daily Schedule & Life Room · Live Steer & Preferences): You (08:42): Oh, just remembered! I am meeting Mr. Wang at 3 PM Thursday—shift my Shanghai train in the itinerary you are building to the 11 AM train with room for lunch and transit. [Fast-Read Steer · Schedule Bot: Updated Thu to 11 AM train + 3 PM meeting in live job (no restart)] | Schedule Bot (08:43): Today todo list and urgent client email summary are ready! Your Thursday change is steered in: [📄 today-brief.md] | Schedule Bot (08:44): Your 3-day Shanghai itinerary is done too—11:00 train, 15:00 meeting, ready for your calendar: [📅 shanghai-trip.ics] [📄 trip-plan.md] | You (08:45): Super smooth! Going forward, avoid pre-8 AM flights and keep a 40-min buffer before key meetings. [Saved as Permanent Habit: Auto-applied to all future travel & schedule plans]" width="100%" />
</p>

- **Change plans mid-run without restarting**: Remember a new 3 PM client meeting while your trip itinerary is still being compiled? Drop one casual message and `Schedule Bot` steers the 11 AM train change directly into the live task—no aborting or repeating yourself.
- **Delivered as each piece finishes**: Your daily brief (`today-brief.md`) lands first, followed immediately by the updated 3-day calendar file (`shanghai-trip.ics`) ready to import straight into your phone.
- **Personal habits stick permanently**: Mention once to avoid pre-8 AM flights and leave a 40-minute buffer before key meetings, and the room remembers it for every trip and schedule that follows.

---

## How Does This Feel Different from Other AI Tools?

### 1. Compared to Raw Codex / Claude Code (Traditional Session-Based Tools)

<p align="center">
  <img src="docs/assets/readme-cmp-codex-en.svg" alt="Compare 01 (Summon Bot vs Raw Codex / Claude Code Session CLIs): Even though session CLIs accept mid-turn messages, managing multiple sessions drains human focus—forcing you to manually orchestrate 4 windows, copy-paste context in a handoff spiral, and rescue long goals stalled by permission prompts or minor environment bugs. Summon Bot puts you in one unified group chat where Lead Bot and specialists split work into parallel background Codex lanes, self-heal minor CLI bumps out-of-band, and verify & merge deliverables back in chat so long goals finish smoothly end-to-end." width="100%" />
</p>

- **It isn't about whether you can interject—it's about eliminating human orchestration fatigue**: Traditional session CLIs do let you send follow-up messages, yet real projects quickly force *you* to act as a multi-session manager—babysitting 4 terminals, manually copy-pasting specs in a **handoff loop**, and constantly rescuing long runs halted by permission stalls or minor environment glitches.
- **Uninterrupted parallel execution from one room**: Summon Bot doesn't replace Codex; it orchestrates multiple Codex / Pi sessions under a unified group chat. You stay focused on goals while Bots split parallel work, keep specs aligned, absorb minor tool bumps automatically, and deliver verified results end-to-end.

---

### 2. Compared to Hermes & Single-Thread Local Assistants

<p align="center">
  <img src="docs/assets/readme-cmp-hermes-en.svg" alt="Compare 02 (Summon Bot vs Hermes and single-thread local assistants): Jamming chat, shell errors, calendar reminders, and coding into one single thread causes execution cross-bleed and forgotten habits after context compaction. Summon Bot is a next-gen personal assistant deployed on your own computer with clean rooms, specialist Bots (Dev Lead, Schedule Bot, Ops & Maintainer), and dedicated automated memory persistence so rules and habits stay intact." width="100%" />
</p>

- **Next-generation local personal assistant**: Deployed right on your own computer, Summon Bot never crams every task into one messy single chat thread. Separate rooms and specialist Bots keep coding, server ops, and daily scheduling cleanly isolated so execution stays calm and predictable.
- **Dedicated automated memory that never forgets**: Personal habits, room conventions, and indexed methods are managed and persisted automatically by specialized memory workflows—surviving long threads and compaction smoothly.

---

### 3. Compared to Grokbot / OpenBot (Cloud Lifestyle Personal Agents)

<p align="center">
  <img src="docs/assets/readme-cmp-grokbot-en.svg" alt="Compare 03 (Summon Bot vs Grokbot / OpenBot cloud lifestyle agents): Big-tech cloud agents focus on remote cloud VMs trying to wire up consumer apps like ordering coffee or shopping—leaving you doing the actual heavy coding and project work yourself. Summon Bot runs 100% locally on your own machine with direct workspace access and your own model accounts, handing real work to Summon so you can brew your own coffee while AI does the work." width="100%" />
</p>

- **Built for real work, not cloud consumer demos**: Big-tech cloud personal agents chase remote cloud VMs wired into consumer apps—great for demos, yet detached from your real repositories, servers, and local toolchains.
- **Brew your own coffee while AI does the work**: Summon Bot runs 100% on your own machine, directly reading your local workspaces and freely mixing your existing Codex, Grok, Claude, and DeepSeek subscriptions. We don't want AI ordering coffee while we grind through work—we want to brew our own coffee while Summon gets the real work done.

---

### 4. Compared to DSH SuperAgent (Central-Router Agents)

<p align="center">
  <img src="docs/assets/readme-cmp-superagent-en.svg" alt="Compare 04 (Summon Bot vs DSH SuperAgent central-router hierarchy): Central-router agents funnel every chat, code log, and tool output into one overloaded central session—bloating context so a single misjudgment derails everything while passive sub-agents cannot challenge or cross-check it. Summon Bot uses a flat peer collaboration mesh where Lead Bot, Specialists, Tool Bot, and EggBot each keep clean isolated context and proactively cross-check and rescue each other—sharper decisions and smoother workflows." width="100%" />
</p>

- **Flat peer management instead of one fragile central brain**: Central-router architectures funnel all context and decisions through a single master session—causing context bloat and single-point misjudgments that passive sub-agents can't challenge.
- **Isolated context + mutual peer cross-checking**: Every Bot in a Summon room maintains a clean, role-isolated context and actively listens for mistakes or risks from teammates. Independent peers catching each other's blind spots consistently beat one overloaded central router.

---

### 5. Four First-Party Native Clients in Sync

<p align="center">
  <img src="docs/assets/readme-clients-en.svg" alt="4 First-Party Clients (Protocol 3), Bloub Vector Paper Avatars, and Purpose-Based Token Ledger: Web App (Paper / Midnight), Electron Desktop (Win / Mac arm64), Native iOS 26 (SwiftUI Liquid Glass), and Native Android (Jetpack Compose). All data stays on your own machine while your phone stays live in sync." width="100%" />
</p>

- Built across **Web (Paper & Midnight themes)**, **Windows / macOS (arm64) Electron Desktop**, **Native iOS 26 (SwiftUI Liquid Glass)**, and **Native Android (Jetpack Compose)**—complete with Protocol 3 real-time sync, Bloub vector paper avatars, and purpose-based token accounting. Kick off a project at your desk, step away to make coffee, and review deliverables or tweak plans right from your phone.

---

### 🗂️ Deep-Dive Documentation

- [System Architecture (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot & 17 Built-in Roles (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [Model Routing & Connections (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub Vector Paper Avatars (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [Client Releases & Auto-Update (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [Deployment & Operations (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>
