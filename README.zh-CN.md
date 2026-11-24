<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="88" />

# Summon Bot

**用群聊推进复杂工作：Bot 会自己听懂话题、缺人时拉新专员入群、发现弯路主动纠错，后台跑重活时前台照常秒回聊天**  
**Run Real Work Through Group Chat · Peers That Know When to Speak, Auto-Recruit Missing Roles, Catch Mistakes, and Never Freeze Your Chat**

![Group Chat](https://img.shields.io/badge/Workflow-Multi--Bot_Group_Chat-477A54?style=flat-square)
![Auto Team](https://img.shields.io/badge/EggBot-Auto_Role_Spawning-A87932?style=flat-square)
![Split Layer](https://img.shields.io/badge/Chat_%26_Work-Never_Freezes-597C91?style=flat-square)
![Clients](https://img.shields.io/badge/Clients-Web_%7C_Desktop_%7C_iOS_26_%7C_Android-2C4C66?style=flat-square)

</div>

---

<a id="top"></a>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-zh.svg" alt="主控 Bot 引导卡片：点击展开简体中文一镜到底群聊实录、场景演示与竞品对比导览" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-zh.svg" alt="Summon Bot 连续群聊实录（上）：从模糊想法聊出航海选路游戏《雾港远征》；01 EggBot 旁听发现每章数值平衡缺专人，无需指令自动 create_bot 孵化 @关卡策划 入群并试算海岸章路线；02 ① 快读层（thinking: off、零写权限）实现无关消息当场 quiet 静默省 90% Token，并在关卡策划想下载 FFmpeg 时由总接口 Bot 免 @ 主动递上本机现成连接 cli-ffmpeg 拦住重复安装。" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-zh.svg" alt="Summon Bot 连续群聊实录（下）：03 ② 群主对话与 ③ 后台执行会话双层分离，后台并行跑路线存档 CLI 与离线战报 HTML 两路 Codex，平台硬门禁（403 room_send_forbidden）禁止执行器直接刷群，前台照常秒回聊第二章雪原章 frost_streak 冻伤机制；04 随口补充 0 字节 blank.png 与前后两列要求由 ① 快读按 route: forward 原生 steer 秒级塞进在途 Codex，后台工具换版报错由群外专责维护 Bot 静默自修；05 先好的先交（10:06 report.json、10:07 report.html 引用原提问）、稳定主线加本轮私有 Fork 保持 90%+ 缓存命中、五层人格与 material_index_ref 将战报格式永久写入本群约定；06 P2 用途模型表为快读、主对话与独立执行分层配模型与思考档，usage.sqlite 独立记账。" width="100%" /></a>
</p>

---

## 在 Summon 群里工作是什么体验？

在 Summon Bot 里，你不需要面对十几个黑框终端，也不需要先写一堆繁琐的角色配置。你只是建了一个群，像和真人团队聊天一样把想法抛出来：

### 1. 缺什么人，群里会自动招什么人（从模糊想法聊出完整团队）

<p align="center">
  <img src="docs/assets/readme-scene-1-zh.svg" alt="场景 1 对话实录（自动招人组队）：你（09:55）：我想做个周末能随时打开玩两把、关掉下次还能接着玩的单机小游戏，做什么题材比较好落地？｜主控 Bot（09:55）：可以做节点选路类的航海远征《雾港远征》，我负责底层路线结算和存档代码。不过每章的路线数值平衡和试玩调表，最好有位固定负责人长期跟进。｜EggBot（09:59，自动发现职责缺口）：已邀请新成员 @关卡策划 入群，专门负责各章路线配置与奖励平衡。｜关卡策划（09:59）：大家好！我刚按初始补给 10 试算了海岸章的两条路线，冒险线（风暴→风暴→遗迹）回报偏低，大家怎么看？" width="100%" />
</p>

- **不用开局准备完美文档**：你不需要一上来就写死完整需求，也不用手写一堆角色提示词，只管像平时讨论那样把模糊想法抛进群里。
- **EggBot 旁听自动建制**：潜伏在群里的 **EggBot** 会持续观察项目进展。一旦聊出新的长期职责缺口（例如每章的路线数值平衡与试玩调表），它不用你下令，就会自动孵化对应专员（`@关卡策划`）拉进群，并把前因后果交接清楚。

---

### 2. 多位 Bot 同处一群：既绝不抢话刷屏，又能在队友走弯路时主动开口救场

<p align="center">
  <img src="docs/assets/readme-scene-2-zh.svg" alt="场景 2 对话实录（静默旁听与免 @ 救场）：你（10:00）：冒险线回报确实偏低，改成每过一处风暴额外多给 1 枚勋章吧，更新一下海岸章表。［快读摘要 · 主控 Bot / EggBot：仅调数值表不改代码，保持静默不抢话］｜关卡策划（10:02）：海岸章 v2 已更新。音频表归我管，我看了下当前目录没转码工具，我先写脚本去下载一份 FFmpeg？｜总接口 Bot（10:02，未被 @ · 主动拦住弯路）：不用重新下载，这台机器已经装好了 FFmpeg 8.1.2，直接用现成连接就行：［🔗 连接 cli-ffmpeg］｜关卡策划（10:02）：太好了，差点重复装一遍！我已经用 cli-ffmpeg 把海岸章音效全转成 ogg 了。" width="100%" />
</p>

- **平时安静旁听，绝不抢话刷屏**：群里每句话都会先经过关闭思考的快读层秒级分流。当你和关卡策划讨论“每过一处风暴多加 1 枚勋章”时，主控 Bot 和 EggBot 一眼看出不改程序代码，当场保持静默，只在气泡下方留下一行简短的已读摘要。
- **关键时刻免 `@` 主动插话救场**：当关卡策划准备“写脚本重新下载 FFmpeg”时，尽管没有任何人 `@总接口 Bot`，一直旁听的总接口 Bot 仍会主动站出来递上本机已装好的现成连接 `cli-ffmpeg`，当场拦住重复下载的弯路。

---

### 3. 聊天与干重活双层分离：后台多路写代码，前台照常秒回聊下一章

<p align="center">
  <img src="docs/assets/readme-scene-3-zh.svg" alt="场景 3 对话实录（聊干双层分离）：你（10:03）：好，那主控现在正式开工写海岸章的结算命令和离线战报 HTML 页面吧！｜主控 Bot（10:03）：好，两项工作我已经同时在后台开工了。后台跑代码不影响我们聊天，趁现在要不要先把第二章「雪原章」的机制定了？｜你（10:04）：行啊，完全不用干等！雪原章我想加个“暴风雪”天气，连续走两步露天节点会冻伤……｜关卡策划（10:04）：这个连续冻伤机制很有意思！那我在雪原章表里加一个 frost_streak 计数，进营地重置为 0。｜［底部状态条：执行过程（2）· #1 路线存档与差异 CLI（Codex 运行中）｜ #2 离线战报 HTML（Codex 构建中）· 前台聊天 0 卡顿］" width="100%" />
</p>

- **聊天层与执行层彻底解耦**：普通 AI 编程工具一旦开始写代码或跑构建，整个聊天框就会卡住几分钟；在 Summon 群里，“陪你聊天的群成员”和“在后台埋头干重活的 Codex / Pi 执行器”是完全分开的。
- **前台聊天永远不卡顿**：哪怕后台正同时跑着两三路繁重的代码编译与复测，群里的 Bot 依然秒回你的每一句话——第一章海岸章还在后台构建，第二章「雪原章」的连续冻伤（`frost_streak`）机制已经在群里聊完了。

---

### 4. 突然想补一句话？不用打断重来，随口一说直接塞进正在跑的任务里

<p align="center">
  <img src="docs/assets/readme-scene-4-zh.svg" alt="场景 4 对话实录（随口补件直转与长期约定）：你（10:05）：对了，刚想起来！海岸章清单里有个 0 字节的 blank.png 是有效占位资源，正在做的战报页面要在新增列表里显示出来，前后大小放两列。［快读直转 · 主控 Bot：战报页补 0 字节与两列（已直接塞进后台在途任务，无需中断重跑）］｜主控 Bot（10:06）：第一项 CLI 已先跑完并通过复测，先交 report.json；你的补件已送进战报页会话：［📄 report.json］｜主控 Bot（10:07）：离线战报 HTML 也做好了！已包含 blank.png (0 B) 与改动前后两列对比：［📄 report.html］［📄 coast-v2.json］｜你（10:10）：完美！以后这个群所有的战报页都默认按这个格式来。［长期约定已落盘 · 后续雪原章、夜航章生成战报自动遵守］" width="100%" />
</p>

- **不用按暂停、不用推倒重来**：后台战报页刚跑到一半，你突然想起要保留 0 字节的 `blank.png` 并把前后大小分两列。只需在群里随口补一句，主控 Bot 毫秒级把要求精准直转进后台在途线程，第一版成品就带齐全部新要求。
- **谁先跑完谁先交，反馈秒改**：CLI 脚本 10:06 先通过复测就先交 `report.json`；战报网页 10:07 合入补件后紧接着交付 `report.html`。双击打开看完提一句修改意见，几秒钟就能拿到改好的新版。
- **说一遍的规矩永远记住**：你拍板一句“以后这个群所有战报页都按这个格式来”，主控就会将其记成本群长期约定，后续做雪原章、夜航章时全员自动照办。

---

## 和平时用的 AI 工具相比，体验有什么不同？

<p align="center">
  <img src="docs/assets/readme-compare-zh.svg" alt="Summon Bot 竞品对比与全原生四端总览图：1. 对比直接用 Codex / Claude Code：告别单线程终端干等，把 Codex 作为后台 ③ 执行引擎并发调度，前台群聊秒回且支持随口补件直转；2. 对比 Grokbot (xAI)：100% 本地自托管主权，自有数据根直接操作本地工作区，自由混搭 Codex/Grok/Claude/DeepSeek；3. 对比 OpenBot / Hermes：内核级 ① 快读静默分流、EggBot 自动招人建制、CLI 升级群外自修与全原生四端；4. 对比 DSH SuperAgent：去中心化同伴协作、前台零 bash 裸奔与代码级权限硬门禁；底部展示全原生四端（Web Paper/Midnight、Electron Win x64/Mac arm64、iOS 26 SwiftUI Liquid Glass、Android Jetpack Compose）、Protocol 3 同步、Bloub 纸片头像与按用途精细记账。" width="100%" />
</p>

- **相比直接用 Codex / Claude Code（单窗口编程助手）**：不是取代 Codex，而是把 Codex / Claude 作为后台 ③ 执行引擎交给群主控统一调度。告别单线程终端一跑代码就卡住的干等——后台多路并行跑重活，前台照常秒回聊下一章、随时插话直转补件。
- **相比 Grokbot (xAI)（云端单厂商 Agent）**：100% 本地自托管主权，不绑死单一厂商的高价云电脑。所有对话、SQLite 状态库、工具回执与凭据均保存在你自己的正式数据根，直接读写本地工作区，自由混搭本机已有的 Codex、Grok、Claude 登录订阅与 DeepSeek 等多模型 API。
- **相比 OpenBot / Hermes（常见多 Agent 群聊框架）**：不止于提示词交接或借壳 Telegram / IM 机器人。从运行时内核实现 ① 快读静默分流（既不抢话刷屏又省下陪聊 Token）、EggBot 自动招人建制，以及 CLI 工具升级报错时由专责维护 Bot 在群外静默修好适配脚本，绝不在业务群刷满报错堆栈。
- **相比 DSH SuperAgent（中心路由式 Agent）**：去中心化同伴协作，无单一中心主 Session 路由瓶颈，前台聊天层也不带 bash 裸奔。每位 Bot 拥有独立的跨群人格与长期记忆，后台执行器与群发言彻底隔离，由平台代码硬门禁强制校验目录授权与并发乐观锁。
- **全自研原生四端随时接力**：提供 **普通网页（Paper / Midnight 双主题）**、**Windows / macOS (arm64) Electron 桌面端**、**iOS 26 原生客户端（SwiftUI Liquid Glass）** 与 **Android 原生客户端（Jetpack Compose）**，统一支持 Protocol 3 实时同步、Bloub 纸片几何动画头像与按用途精细记账。在电脑上开好工，出门拿手机就能随时看群里交上来的战报或补一句新想法。

---

### 🗂️ 深入了解与专项文档

如果你想了解背后的架构与部署细节，可以直接查看以下专项文档：

- [系统总体架构 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot 自动组队与 17 种内置岗位 (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [模型路由与执行连接 (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub 纸片几何头像 (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [四端发行与自动更新 (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [部署与日常运维 (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-en.svg" alt="Lead Bot & EggBot Guide Card: Click to expand the English continuous group chat walkthrough, scenario cards, and tool comparison" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-en.svg" alt="Summon Bot Continuous Walkthrough (Part 1): From a rough single-player game idea to Mistport Expedition; 01 EggBot observes the room, spots a long-term balance ownership gap, calls create_bot to spawn @LevelDesigner who immediately simulates Coast routes; 02 ① Fast-Read layer (thinking: off, zero write access) stays quiet on unrelated turns saving 90% tokens, and Tool Bot proactively steps in without @mention to hand over cli-ffmpeg when LevelDesigner is about to download FFmpeg redundantly." width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-en.svg" alt="Summon Bot Continuous Walkthrough (Part 2): 03 ② Main Room Chat and ③ Background Execution Sessions are cleanly split—two parallel Codex jobs build the Coast diff CLI and offline HTML report under a code hard gate (403 room_send_forbidden) while chat stays instant to design Chapter 2 Snowfield (frost_streak); 04 Casual mid-build addendum (0-byte blank.png & 2 size columns) is steered via ① Fast-Read route: forward directly into the live Codex thread, and broken CLI tools are silently self-repaired out-of-band by a Maintainer Bot; 05 Staged verified delivery (10:06 report.json, 10:07 report.html quoting the original request), stable trunk + private fork (90%+ cache hit), and 5-layer persona/material_index_ref persisting room conventions permanently; 06 P2 purpose-based model routing table assigns distinct models and thinking levels to Fast-Read, Main Chat, and Standalone Execution with usage.sqlite accounting." width="100%" /></a>
</p>

---

## What Does Working in a Summon Group Chat Feel Like?

In Summon Bot, you don't juggle a dozen terminal tabs or hand-craft YAML role prompts before starting. You simply open a group chat and talk through a rough idea like you would with a real team:

### 1. Missing a Specialist? The Room Recruits One Automatically

<p align="center">
  <img src="docs/assets/readme-scene-1-en.svg" alt="Scene 1 Dialogue (Auto-Recruiting): You (09:55): I want to build a lightweight single-player game I can play in short sessions and resume anytime. What genre is easy to ship and fun to replay? | Lead Bot (09:55): How about a node-based maritime expedition called Mistport Expedition? I will own route settlement and save files, though chapter balance needs a dedicated owner. | EggBot (09:59, Spotted Role Gap): Invited @LevelDesigner to own chapter tables and playtest balance. | LevelDesigner (09:59): Hi all! With 10 starting supply, I simulated two Coast routes—the risky Storm route gives the same 2 medals as the safe route. Payoff feels low—thoughts?" width="100%" />
</p>

- **Start vague, not with a finished spec**: You never need an upfront PRD or five manually engineered role prompts—just drop a rough idea and brainstorm naturally.
- **EggBot spawns missing roles automatically**: Quietly observing the room, **EggBot** detects long-term ownership gaps (like ongoing chapter balance and playtest tables), spawns `@LevelDesigner`, invites her into the room, and hands off prior context without you having to ask.

---

### 2. Multiple Bots in One Room: Never Talking Over Each Other, Yet Catching Mistakes

<p align="center">
  <img src="docs/assets/readme-scene-2-en.svg" alt="Scene 2 Dialogue (Quiet Triage & Proactive Rescue): You (10:00): Agreed—make every Storm node grant +1 bonus medal and update the Coast table. [Fast-Read · Lead Bot & EggBot: Table tweak only, no code impact—staying quiet] | LevelDesigner (10:02): Coast v2 is pinned! I do not see an audio converter in the workspace—shall I write a script to download FFmpeg first? | Tool Bot (10:02, No @mention · Proactive Rescue): No need to download—FFmpeg 8.1.2 is already installed on this host. Use this connection: [🔗 cli-ffmpeg] | LevelDesigner (10:02): Awesome, saved a redundant install! Converted all Coast audio to ogg via cli-ffmpeg." width="100%" />
</p>

- **Quiet when unrelated**: Every message first passes through a zero-thinking Fast-Read triage layer. When you reply to LevelDesigner about granting +1 bonus medal per storm node, Lead Bot and EggBot see it doesn't affect code and stay quiet—leaving only a compact 1-line read summary under your bubble.
- **Proactive rescue without `@mention`**: Even when nobody tags `Tool Bot`, the moment it overhears LevelDesigner about to write a script to redundantly download FFmpeg already installed on the host, it steps in on its own to hand over `cli-ffmpeg` and prevent wasted work.

---

### 3. Chatting Never Waits on Heavy Work: Code Runs in Background While You Plan Chapter 2

<p align="center">
  <img src="docs/assets/readme-scene-3-en.svg" alt="Scene 3 Dialogue (Chat & Heavy Work Split): You (10:03): Great, let us start coding the Coast CLI and the offline HTML battle report now! | Lead Bot (10:03): Started both jobs in parallel in the background. Background coding does not block our chat—want to design Chapter 2 Snowfield while they run? | You (10:04): Love not waiting on a frozen terminal! For Snowfield, let us add a blizzard rule where 2 exposed nodes in a row cause frostbite (-1 extra supply)... | LevelDesigner (10:04): Great mechanic! I will add a frost_streak counter to Snowfield that resets at Camp. | [Footer status bar: Background Jobs (2) · #1 Route/Save Diff CLI (Codex running) | #2 Offline HTML Report (Codex building) · Zero Chat Freeze]" width="100%" />
</p>

- **Chat layer and heavy execution are completely separated**: In single-threaded coding assistants, saying *"start coding"* freezes your window for minutes. In Summon Bot, talking in the room and running Codex / Pi execution jobs happen in completely separate layers.
- **Zero chat freeze**: Even while two or three heavy coding, bundling, and verification jobs run in parallel in the background, every Bot in the room replies instantly—by the time Chapter 1 finishes building, you've already designed Chapter 2 Snowfield and its `frost_streak` blizzard mechanic.

---

### 4. Forgot a Detail Mid-Build? Just Say It—It Steers Straight into the Running Job

<p align="center">
  <img src="docs/assets/readme-scene-4-en.svg" alt="Scene 4 Dialogue (Live Steer & Room Memory): You (10:05): Oh, just remembered! The 0-byte blank.png in Coast is a valid placeholder—make sure the HTML report lists it and puts before/after sizes in two columns. [Fast-Read Steer · Lead Bot: Injected 0-byte & 2-column rule into live HTML job (no restart)] | Lead Bot (10:06): Job #1 CLI finished first and passed checks! Live steer already sent to HTML job: [📄 report.json] | Lead Bot (10:07): Offline HTML report is ready too—includes blank.png (0 B) and 2 size columns: [📄 report.html] [📄 coast-v2.json] | You (10:10): Perfect! Keep this exact report format for all future chapters in this room. [Saved as Room Convention: Auto-applied to Snowfield and all future chapters]" width="100%" />
</p>

- **No aborting, no restarting**: Mid-build, you remember that 0-byte `blank.png` must be listed with two before/after size columns. Drop one casual message and Lead Bot's Fast-Read layer steers it directly into the live background HTML job so the very first build comes out right.
- **Delivered as soon as verified**: Whichever job finishes first delivers first (`report.json` at 10:06, followed by `report.html` at 10:07 with your live steer already applied). Ask for a UI tweak and receive the re-bundled file in seconds.
- **Room rules stick forever**: Say *"keep this exact report format for all future chapters in this room"* once, and Lead Bot persists it as a permanent room convention automatically honored across Snowfield and every chapter after.

---

## How Does This Feel Different from Other AI Tools?

<p align="center">
  <img src="docs/assets/readme-compare-en.svg" alt="Summon Bot Comparison & 4 First-Party Clients Overview Graphic: 1. vs Raw Codex / Claude Code: No single-thread terminal freeze—orchestrates Codex as background ③ engines with instant foreground chat, parallel jobs, and live mid-run steer; 2. vs Grokbot (xAI): 100% local self-hosted ownership on your own machine with direct local workspace access and free mixing of Codex, Grok, Claude, and DeepSeek; 3. vs OpenBot / Hermes: Kernel-level ① Fast-Read silence triage, EggBot auto-spawning, silent out-of-band CLI repair, and 4 native clients; 4. vs DSH SuperAgent: Decentralized peer collaboration, isolated execution with no bash on the chat router, and strict code hard gates; Bottom banner highlights 4 first-party clients (Web Paper/Midnight, Electron Desktop Win/Mac arm64, Native iOS 26 Liquid Glass, Native Android Jetpack Compose), Protocol 3 sync, Bloub vector paper avatars, and purpose-based token ledger." width="100%" />
</p>

- **Compared to Raw Codex / Claude Code (Single-Window Coding CLIs)**: Summon Bot doesn't replace Codex—it orchestrates Codex / Claude as background ③ execution engines. No more staring at a frozen terminal while a build runs: execute multiple coding jobs in parallel while brainstorming the next chapter and steering live jobs right from chat.
- **Compared to Grokbot (xAI) (Single-Vendor Cloud Agent)**: 100% local self-hosted ownership with zero cloud VM lock-in. All chats, SQLite state ledgers, tool receipts, and credentials stay in your own data root on your machine, operating directly on local workspaces while freely mixing your existing Codex, Grok, Claude, and DeepSeek accounts.
- **Compared to OpenBot / Hermes (Typical Multi-Agent Frameworks)**: Goes beyond prompt-level handoffs or borrowed Telegram UIs. Runtime-level ① Fast-Read silence triage eliminates spam and wasted tokens, EggBot recruits specialists automatically, and if a local CLI tool breaks after an upgrade, a dedicated maintainer bot silently repairs its adapter outside the room instead of dumping stack traces into your chat.
- **Compared to DSH SuperAgent (Central-Router Agents)**: Decentralized peer collaboration with no single central-session routing bottleneck and no raw bash on the chat layer. Every Bot maintains cross-room persona and memory under strict platform-enforced directory grants and optimistic revision locks.
- **4 First-Party Native Clients in Sync**: Built across **Web (Paper & Midnight themes)**, **Windows / macOS (arm64) Electron Desktop**, **Native iOS 26 (SwiftUI Liquid Glass)**, and **Native Android (Jetpack Compose)**—complete with Protocol 3 real-time sync, Bloub vector paper avatars, and purpose-based token accounting. Kick off a build at your desk and check delivered reports or steer a live task from your phone.

---

### 🗂️ Deep-Dive Documentation

- [System Architecture (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot & 17 Built-in Roles (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [Model Routing & Connections (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub Vector Paper Avatars (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [Client Releases & Auto-Update (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [Deployment & Operations (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>
