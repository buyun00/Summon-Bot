<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="88" />

# Summon Bot

**Less is More · 像坐进 Cybercab 一样，不用面对飞机引擎般的复杂面板与概念，只需像平时群聊一样说出目的地，直接自动驾驶出发**  
**Less is More · A Cybercab for AI Work: No Cockpit Panels or Concepts to Learn—Just Say Where You Want to Go in Group Chat, and Self-Drive There**

![Philosophy](https://img.shields.io/badge/Philosophy-Cybercab_Autopilot-23211E?style=flat-square)
![Group Chat](https://img.shields.io/badge/Interface-Just_Group_Chat-477A54?style=flat-square)
![Auto Team](https://img.shields.io/badge/EggBot-Auto_Role_Spawning-A87932?style=flat-square)
![Split Layer](https://img.shields.io/badge/Chat_%26_Work-Never_Freezes-597C91?style=flat-square)
![Clients](https://img.shields.io/badge/Clients-Web_%7C_Desktop_%7C_iOS_26_%7C_Android-2C4C66?style=flat-square)

</div>

---

<a id="top"></a>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-zh.svg" alt="点击展开简体中文群聊实录与完整导览" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-zh.svg" alt="Summon Bot 连续群聊实录（上）：从模糊想法发散、EggBot 自动招人组队到快读静默分流" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-zh.svg" alt="Summon Bot 连续群聊实录（下）：聊干双层分离、随口补件直转 Codex、分批交付与长期约定落盘" width="100%" /></a>
</p>

---

## 为什么我们造了一辆 Cybercab，而不是又一台“飞机引擎”？

看今天大多数 AI 工作台（无论是 Multica、LobeHub 还是各种多 Agent 编排器）的教学视频，你总得先花半天时间学一堆它们造出来的新概念：什么是“工作区”、什么是“看板”、什么是“节点流程图”、怎么手写 5 个角色的提示词……整个工具复杂得像把一台**飞机引擎和满墙仪表盘**塞进你手里，你得先考个飞行员执照才能起飞。

**Summon Bot 的理念恰恰相反：Less is More——我们是一辆没有方向盘和复杂仪表盘的 Cybercab（自动驾驶出租车）。**

AI 时代的工具不应该再是让你和一堆按钮、面板、概念斗智斗勇的复杂工具，而应该是一个**直指目标的自动驾驶**。你坐进车里，眼前只有最熟悉、最干净的**群聊对话框**——你唯一要做的，就是像平时和朋友微信聊天一样说出你想去的目的地，剩下的招人、分工、跑代码、纠错、修工具，全部自动驾驶出发：

---

### 1. 不用先学怎么配团队：你说出想法，群里缺什么人会自动招什么人

别的多 Agent 工具要你开局先填满一堆角色设定表单；在 Summon 群里，你哪怕只有一句模糊的念头就能直接发车：

```text
你：我想做个周末能随时打开玩两把、关掉下次还能接着玩的单机小游戏，做什么题材比较好？
主控 Bot：可以做节点选路类的航海远征《雾港远征》，我来负责底层路线结算和存档代码。
        不过每章的路线数值平衡和试玩调表，最好有位固定负责人长期跟进。
EggBot：已邀请新成员 @关卡策划 入群，专门负责各章路线配置与奖励平衡。
关卡策划：大家好！我刚按初始补给 10 试算了海岸章的两条路线，冒险线回报偏低，大家怎么看？
```

- **零概念负担**：你根本不需要去管什么“Agent 拓扑”或“新建角色”。潜伏在群里的 **EggBot** 听着你们聊天，发现缺个长期管数值的策划，自己就把 `@关卡策划` 招进群里并交接好上下文了。

---

### 2. 不用你当调度员挨个点名：既不会全员抢话刷屏，又能在队友走弯路时主动开口救场

把几个 Bot 放在同一个群里，你不需要去学怎么写路由规则，也不需要死板地每句话手动 `@某人`：

```text
关卡策划：音频表归我管，我看了下当前目录没转码工具，我先写脚本去下载一份 FFmpeg？
总接口 Bot：不用重新下载，这台机器已经装好了 FFmpeg 8.1.2，直接用这个现成连接就行：[🔗 连接 cli-ffmpeg]
关卡策划：太好了，差点重复装一遍！我已经用它把海岸章音效全转成 ogg 了。
```

- **无关时安静旁听**：你和关卡策划聊勋章数值时，主控 Bot 和 EggBot 看一眼就知道不用改代码，当场保持安静，绝不跳出来复读刷屏。
- **看队友走弯路主动插话**：上面根本没人 `@总接口 Bot`，但它旁听到队友要“重复下载电脑里已有的软件”，自己就会开口递上现成工具，当场把弯路拦住。

---

### 3. 聊天与干重活双层分离：后台多路写代码，前台照常秒回聊下一章

普通 AI 编程工具一旦开始写代码或跑构建，窗口就卡死几分钟，你只能盯着屏幕干等。而在 Summon 群里，**“陪你聊天的群友”和“在后台埋头干重活的执行器”是双层分离的**：

```text
你：好，那主控现在正式开工写海岸章的结算命令和离线战报 HTML 页面吧！
主控 Bot：好，两项工作我已经同时在后台开工了。后台跑代码不影响我们聊天，趁现在要不要先把第二章「雪原章」的机制定了？
你：行啊，完全不用干等！雪原章我想加个“暴风雪”天气，连续走两步露天节点会冻伤……
关卡策划：这个连续冻伤机制很有意思！那我在雪原章表里加一个 frost_streak 计数，进营地重置为 0。
```

- **聊天永远不卡顿**：哪怕后台正同时跑着两三路繁重的代码编译与测试，群里的 Bot 依然秒回你的每一句话。第一章代码还在后台跑，第二章的策划案已经在群里聊完了。

---

### 4. 半路想改主意？不用按暂停重来，随口补一句直接塞进正在跑的任务里

车开到半路，你突然想起漏交代了一个细节：

```text
你：对了，刚想起来！海岸章清单里有个 0 字节的 blank.png 是有效占位资源，正在做的战报页面要在新增列表里显示出来，前后大小放两列。
   └─ [快读摘要 · 主控 Bot：战报页补 0 字节与两列（已直接塞进后台在途任务）]
```

- **随口一说就能微调航向**：不用按暂停、不用杀掉重跑。你在群里随口补一句，主控 Bot 毫秒之间就把它直接塞进了后台正在生成战报页面的任务里，做出来的第一版就是带齐新要求的成品。
- **说一遍的规矩永远记住**：你拍板一句“以后这个群所有战报页都按这个格式来”，整个群就会把它记成长期规矩，往后每一章自动照办。

---

## 这就是我们和其他 AI 工具最大的区别

- **对比复杂的多功能 AI 工作台（如 Multica / LobeHub / 各种画布看板工具）**：它们做的是“飞机驾驶舱”，给你造了无数个工作区、看板、插件开关和配置概念让你去学、去操作；**Summon 做的是 Cybercab（自动驾驶）**，把一切复杂面板全部砍掉，只留一个你每天都在用的干净群聊——你说目的地，车自己开过去。
- **对比单窗口编程终端（如直接用 Codex / Claude Code）**：不再对着一跑代码就卡住的黑框干等。后台多路代码并行狂飙，前台照常秒回聊天，半路随口补话直接塞进在途任务。
- **对比传统多 Agent 框架（如 OpenBot / Hermes / 中心路由式 Agent）**：不用开局手写一堆角色提示词（缺人自己招），不会几个 Bot 抢话刷屏也不必死板 `@` 点名（看到队友走弯路会主动救场），后台工具就算报错也会在群外自己静默修好。
- **全自研原生四端随时上车**：提供 **Web 网页端（Paper / Midnight 双主题）**、**Windows / macOS (arm64) 桌面端**、**iOS 26 原生客户端（SwiftUI Liquid Glass）** 与 **Android 原生客户端（Jetpack Compose）**。在电脑上交代完目标，出门拿手机随时在群里看成果或补一句新想法。

---

### 🗂️ 深入了解与专项文档

- [系统总体架构 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot 自动组队与 17 种内置岗位 (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [模型路由与执行连接 (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub 纸片几何头像 (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [四端发行与自动更新 (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [部署与日常运维 (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-en.svg" alt="Click to expand English Walkthrough & Group Workflow Guide" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-en.svg" alt="Summon Bot Continuous Walkthrough (Part 1): From Vague Idea to EggBot Spawning & Fast-Read Triage" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-en.svg" alt="Summon Bot Continuous Walkthrough (Part 2): Parallel Codex Split, Live Steer, Staged Delivery & Memory" width="100%" /></a>
</p>

---

## Why We Built a Cybercab Instead of Another Jet Engine Cockpit

Watch tutorial videos for most AI workspaces today—whether Multica, LobeHub, or node-graph agent builders—and you always have to study their vocabulary first: *workspaces, kanban boards, workflow canvases, agent handoff graphs, role prompt templates...* The tool feels like a **jet engine cockpit** covered in switches and gauges, forcing you to wrestle with features before getting any actual work done.

**Summon Bot is built on the opposite belief: Less is More. We built a Cybercab.**

In the AI era, software shouldn't be a complex cockpit you have to pilot manually—it should be **self-driving autonomy aimed straight at your goal**. When you step into Summon Bot, there are no intimidating dashboards or concepts to learn. There is only a clean, familiar **group chat**. You simply say where you want to go—just like texting friends—and the vehicle drives itself:

---

### 1. Zero Upfront Role Setup: Speak Your Idea, and the Room Recruits Who It Needs

Other multi-agent tools make you configure 5 role prompts before typing hello. In a Summon room, you hop in with a vague thought and start moving immediately:

```text
You:      I want to build a lightweight single-player game I can play in short sessions and resume anytime.
Lead Bot: How about a node-based maritime expedition called *Mistport Expedition*? I'll own route settlement
          and save files, though ongoing chapter balance and playtest tuning should have a dedicated owner.
EggBot:   Invited @LevelDesigner to own chapter tables and playtest balance.
LevelDesigner: Hi all! With 10 starting supply, I simulated two Coast routes—the risky route payoff feels low. Thoughts?
```

- **No concepts to learn**: You never touch an "agent topology editor." **EggBot** listens to your chat, notices nobody owns long-term chapter economy balance, spawns `@LevelDesigner` on the spot, and briefs her automatically.

---

### 2. No Manual Traffic Control: Bots Never Spam, Yet Jump In to Catch Mistakes

Put 4 bots in one room without wrestling with routing rules or `@mention` babysitting:

```text
LevelDesigner: I don't see an audio converter in the workspace—shall I write a script to download FFmpeg first?
Tool Bot:      No need to download—FFmpeg 8.1.2 is already installed on this machine. Use this connection: [🔗 cli-ffmpeg]
LevelDesigner: Awesome, saved a redundant install! Converted all Coast audio to ogg via cli-ffmpeg.
```

- **Quiet when unrelated**: When you discuss storm medal numbers with LevelDesigner, Lead Bot and EggBot see it doesn't affect their code and stay quiet—no robotic 4-bot echo chamber.
- **Proactive rescue without `@mention`**: Nobody tagged `Tool Bot` above, yet when it overheard a teammate about to redundantly download software already on the machine, it spoke up on its own to hand over the ready tool.

---

### 3. Chat & Heavy Work Are Split: Code Runs in Background While You Plan Chapter 2

In single-window coding CLIs, saying *"start coding"* locks your chat for minutes. In Summon Bot, **talking in the room and running heavy jobs live on two separate layers**:

```text
You:      Great, let's start coding the Coast CLI and the offline HTML battle report now!
Lead Bot: Started both jobs in parallel in the background. Background coding doesn't block our chat—want to
          design Chapter 2 Snowfield while they run?
You:      Love not waiting on a frozen terminal! For Snowfield, let's add a blizzard rule where 2 exposed nodes cause frostbite...
LevelDesigner: Great mechanic! I'll add a frost_streak counter to the Snowfield table that resets at Campfire nodes.
```

- **Chat never freezes**: Even while multiple heavy coding and bundling jobs run in the background, every Bot in the room replies instantly. By the time Chapter 1 finishes compiling, Chapter 2 is already designed.

---

### 4. Change Your Mind Mid-Ride? Just Say It—It Steers Straight into the Live Job

Halfway to your destination, you remember an extra detail:

```text
You: Oh, just remembered! The 0-byte blank.png in the Coast manifest is a valid placeholder—make sure the HTML report
     shows it and puts before/after sizes in two columns.
     └─ [Fast-Read · Lead Bot: Add 0-byte & 2 columns (steered directly into live HTML job)]
```

- **Nudge the destination on the fly**: No hitting pause, no aborting and restarting. Drop a casual sentence in the chat and Lead Bot steers it straight into the running build thread so the first delivery includes it.
- **Say a rule once, keep it forever**: Tell the room *"keep this exact report format for all future chapters"* once, and the whole team follows it automatically from then on.

---

## How Summon Bot Differs from Every Other AI Tool

- **Compared to complex AI workspaces (Multica / LobeHub / Canvas & Kanban Builders)**: They hand you a jet cockpit full of workspaces, boards, plugins, and concepts you have to study and operate. **Summon Bot is a Cybercab**—we stripped away the dashboard clutter so you just sit in a clean group chat, state your destination, and let the system self-drive.
- **Compared to single-window coding terminals (Raw Codex / Claude Code)**: No staring at a frozen terminal while code compiles. Background jobs run in parallel while foreground chat stays instant and steers live work mid-flight.
- **Compared to traditional multi-agent frameworks (OpenBot / Hermes / Router Agents)**: No upfront YAML role engineering (EggBot recruits as needed), no spam or forced `@mention` babysitting (peers stay quiet when unrelated but jump in to stop mistakes), and broken CLI scripts self-heal outside the room without spamming error traces.
- **Hop In from 4 Native Apps**: Synced in real time across **Web (Paper & Midnight themes)**, **Windows / macOS (arm64) Desktop**, **Native iOS 26 (SwiftUI Liquid Glass)**, and **Native Android (Jetpack Compose)**.

---

### 🗂️ Deep-Dive Documentation

- [System Architecture (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [EggBot & 17 Built-in Roles (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [Model Routing & Connections (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [Bloub Vector Paper Avatars (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [Client Releases & Auto-Update (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [Deployment & Operations (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)

</details>
