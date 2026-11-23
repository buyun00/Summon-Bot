<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="88" />

# Summon Bot

**自托管多智能体群聊协作工作台 · 把本机 Codex / Grok / Claude / DeepSeek 编排成会自己招人、分流与修工具的本地团队**  
**Self-Hosted Multi-Agent Group Chat Workspace · Orchestrating Local Codex, Grok, Claude & DeepSeek into an Autonomous Team**

![Node.js 24](https://img.shields.io/badge/Node.js-24_LTS-3C873A?style=flat-square&logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Local_Data_Root-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Models](https://img.shields.io/badge/Models-Codex_%7C_Grok_%7C_Claude_%7C_DeepSeek-597C91?style=flat-square)
![Clients](https://img.shields.io/badge/Clients-Web_%7C_Desktop_%7C_iOS_26_%7C_Android-477A54?style=flat-square)
![Avatars](https://img.shields.io/badge/Avatars-Bloub_Vector_Paper-A87932?style=flat-square)

</div>

---

<a id="top"></a>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-zh.svg" alt="点击展开简体中文群聊实录与完整架构详解" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-zh.svg" alt="Summon Bot 连续群聊实录（上）：从模糊想法发散、EggBot 自动招人组队到快读静默分流" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-zh.svg" alt="Summon Bot 连续群聊实录（下）：聊干双层分离、随口补件直转 Codex、分批交付与长期约定落盘" width="100%" /></a>
</p>

---

## 1. 为什么做 Summon Bot？我们解决的四大核心痛点

1. **解决“单线程终端干等”痛点（聊干双层分离）**
   - **现状痛点**：直接用 Codex CLI 或 Claude Code 时，一旦你说“开始写代码/跑构建”，当前对话窗口就会被长耗时工具调用锁死数分钟。等待期间你没法顺手讨论下一章设计，也没法同时让它并行跑另一套脚本。
   - **Summon 解法**：负责群聊沟通的 **② 群主对话** 只做需求收敛、派单与最终复测交付；真正写代码、跑测试、构建包体的重活全部下沉到后台 **③ 独立执行会话（Standalone Pi / 外部 Codex 会话）** 并行执行。后台两路 Codex 狂飙时，前台群聊依然秒回。
2. **解决“多 Agent 群聊要么全员抢话刷屏、要么装死漏事”痛点（① 零思考快读分流）**
   - **现状痛点**：传统多智能体框架放 4 个 Bot 在群里，要么每句话唤醒所有大模型排队复读（浪费 90% Token 且刷屏），要么规定“必须手动 `@某人` 才说话”，导致队友准备重复下载系统里已有的工具时没人拦。
   - **Summon 解法**：群里每条新消息先经过每位在场 Bot 的只读、零思考（`thinking: off`）**① 快读收件层**：与自己无关时直接返回 `route: quiet` 静默结束，绝不唤醒昂贵的 ② 主对话；但当旁听的 `总接口 Bot` 快读发现队友说“我写脚本重新下一份 FFmpeg”时，无需被 `@`，快读识别出工具走弯路并主动唤醒自己递上现成的 `cli-ffmpeg` 连接。
3. **解决“中途想补一句话，只能强行打断重来或干等跑完”痛点（快读秒级 `steer` 直转）**
   - **现状痛点**：后台 Agent 正在生成战报页面，你突然想起“0 字节占位图也要算有效资源、表格改成前后两列”。传统工具里你只能按 `Ctrl+C` 杀掉重跑，或者等它做完错版再返工。
   - **Summon 解法**：主控的 ① 快读识别出你这句补充正好对应后台在途会话 `#2`，**无需唤醒主控 ② 主对话**，直接返回 `route: forward` 并通过 Codex 原生协议的 `steer` 把原话秒级塞进正在跑的后台线程，一次成型。
4. **解决“用户一上来没有完整需求文档、也不想手写一堆 Agent Prompt”痛点（EggBot 自动观察招人）**
   - **现状痛点**：很多多智能体框架要求用户开局先配好 5 个角色的系统提示词和流程图；而真实项目往往始于一句模糊的“我想做个周末能随时玩的轻量小游戏”。
   - **Summon 解法**：你只需和主控 Bot 像平时一样多轮发散聊天；潜伏在群里的 `EggBot` 按消息步长静默观察进展，一旦发现“主控接了底层代码，但每章路线数值平衡与试玩调表缺专人长期跟进”，立即自动调用 `create_bot` 孵化出 `@关卡策划` 拉进群并把前文上下文交接清楚。

---

## 2. 六大核心架构设计亮点

### ① 三层会话流水线与代码级硬门禁

Summon Bot 在运行时内核将每个 Bot 的工作流严格拆分为三层，并通过平台代码硬门禁（而非脆弱的提示词叮嘱）保证纪律：

| 层级 | 职责 | 权限与平台代码硬门禁 | 默认模型与思考档位 |
| :--- | :--- | :--- | :--- |
| **① 快读收件层**<br/>`fast_read` | 群每来一条新消息，只读判断跟自己有没有关系、属于哪笔在途任务，并写出一句话事实摘要。 | **零写权限**（无 `room_send` / 无 `bash`），强制 `thinking: off`。输出五选一路由：`quiet` / `forward` / `main` / `new_session` / `cancel`。 | `gpt-6.1-terra` / `deepseek-flash`<br/>**`thinking: off`** |
| **② 群主对话层**<br/>`conversation` | 群内唯一对外人格：陪用户发散设计、拆分任务派给 ③、验收 ③ 的成果并在群里引用原提问交付。 | 拥有群发言权（`room_send`）与会话调度权；同一轮多次工具调用对外坍缩为单条回复。 | `gpt-6.1-terra` / `deepseek-flash`<br/>**`thinking: high`** |
| **③ 独立执行会话**<br/>`pi_session` / `codex` | 在各自独立的工作目录里写代码、跑 CLI、做验证，支持单 Bot 并发跑多路会话。 | **平台代码硬门禁禁止直接向群发消息**（调用群发送接口直接拦截返回 `403 room_send_forbidden`），彻底杜绝后台刷屏。 | `gpt-6.2-sol` / `gpt-6.2-astra`<br/>**`thinking: xhigh / max`** |

- **气泡下方的独立摘要通道（`room-message-summaries`）**：每位 Bot 的 ① 快读产出的单行摘要（例如 `关卡策划：用户要求每处风暴 +1 勋章并更新海岸章表`）通过独立的 WebSocket 事件实时挂载到用户气泡下方的折叠胶囊里，**绝不写入消息正文，零上下文污染**。

### ② 稳定公开主线 + 本轮私有分支（90%+ Prompt 缓存命中率）

- 在同一轮执行期间，公开主线 `A` 派生出包含中间工具回执与插话的私有分支 `A → B → C`，保证当前轮内前缀只增不改；
- 当本轮最终结果 `D` 发布到群里后，下一轮自动将历史收敛为干净的公开主线 `A → C → D`（剥离瞬态工具噪音），实测保持 **90% 以上的 Prompt 缓存命中率**。

### ③ 五层人格架构与抗压缩资料索引（`material_index_ref`）

每个 Bot 的行为由五层优先级严格叠加，并配合结构化 SQLite 记忆库实现“越用越懂规矩”：
1. **第一层 · 平台硬底线**：代码级目录授权（`grant_dir`）、乐观锁版本校验（`expected_revision`）、③ 禁群发。
2. **第二层 · 本轮用户要求**：当前消息或被引用消息的明确指令。
3. **第三层 · 本群长期约定**：通过 `material_index_ref`（`applies_to: room`）落盘的本群持久规矩（如“本群所有战报页固定前后两列、0 字节算有效资源”），**即使群聊历史被压缩也永久置顶注入**。
4. **第四层 · 个体跨群性格与笔记**：该 Bot 在 `individual_note` 与 `daily_reflection` 中跨群积累的个人经验。
5. **第五层 · 17 种内置岗位底色**：主控、EggBot、总接口、策划、架构、审计等开箱即用的专业分工底色。

### ④ 本地工具全生命周期与群外静默自愈

- **总接口 Bot**：首次启动自动探测宿主机已安装的 CLI 并完成冒烟测试与注册；当群里其他 Bot 找不到工具时主动免 `@` 递交连接。
- **专责维护 Bot 与群外自愈**：每个连接都绑定一位专责维护 Bot。当某个 CLI 因软件升级导致参数报错时，业务 Bot 直接调用 `send(to: connection)` 把错误回执发给维护 Bot；维护 Bot 在**业务群外**自动修改适配脚本并热更新，主群全程零报错刷屏。
- **内置「Bot 维护群」每日早会**：系统预置专门的维护群，每天自动汇总 `connection_usage` 调用账本开早会沉淀标准工具方法。

### ⑤ 按用途分级配模型与精细记账（`usage.sqlite`）

- 直接复用你本机已登录的 **Codex 订阅、Grok、Claude 或 DeepSeek API Key**，通过统一的 **用途模型表** 将 `① 快读`、`② 群聊`、`③ 代码执行` 分别绑定到最划算的模型与思考档位；所有调用逐笔写入 `usage.sqlite` 按用途独立统计。

### ⑥ Bloub 矢量纸片几何头像引擎

- 每位 Bot 都拥有由内置几何骨骼引擎（`PaperRig`）驱动的 **Bloub 纸片剪影头像**，支持 `squircle`（圆角方）、`galet`（鹅卵石）、`nuage`（云朵）、`triangle`（三角）等十余种纸片造型、3D 透视眼神矩阵与实时姿态动画。

---

## 3. 为什么选 Summon Bot？与直接用 Codex 及主流 Agent 产品的深度对比

| 对比维度 | **Summon Bot (本项目)** | 直接用 Codex / Claude Code | Grokbot (xAI) | OpenBot / Hermes Bot | DSH SuperAgent |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **定位与形态** | **自托管多 Bot 群聊协作工作台**（把 Codex 等作为后台 ③ 引擎调度） | 单线程终端 / IDE 单一编程助手 | 云端托管的单一厂商社交/工作空间助手 | 接入 Telegram/Discord 的多角色聊天 Bot 框架 | 中心路由式（Central Router）多 Agent 协作系统 |
| **写代码时前台能否继续聊天？** | **完全不卡顿**：② 群聊与 ③ 后台执行分离，后台两路 Codex 跑代码时前台照常秒回聊下一章 | **单窗口阻塞**：执行重任务时当前会话锁死，只能干等或另开孤立终端 | 视云端队列而定，缺乏本机多进程实时双工调度 | 多数为单轮串行工具调用，重任务期间群聊响应停滞 | 中心路由需等待子 Agent 返回或通过轮询汇报 |
| **在途任务中途补需求** | **① 快读秒级直转（`route: forward`）**：不唤醒主对话，直接通过原生 `steer` 注入在途 Codex 线程 | 需手动按 `ESC / Ctrl+C` 打断当前执行再重发，或等跑完返工 | 不支持对本机在途构建线程做毫秒级热注入 | 不支持，新消息会排队到下一轮或触发重复并发 | 需经中心 Router 重新拆单下发，延迟高 |
| **多 Bot 群聊防刷屏与主动救场** | **内核级 ① 零思考快读（`thinking: off`）**：无关时 `quiet` 省 90% Token；发现队友走弯路时免 `@` 主动递工具 | 无多 Bot 群聊概念 | 偏单主 Agent 或固定指令触发 | 靠系统提示词或强制 `@mention`，容易全员复读或装死漏事 | 靠单一中心 Router 点名分配，被点名的 Agent 无法自发旁听救场 |
| **团队组建方式** | **EggBot 自动观察招人**：从模糊想法开聊，发现职责缺口自动调用 `create_bot` 孵化专员入群 | 需人工开多个终端并手动复制粘贴上下文 | 预设固定角色或手动切换模式 | 需用户提前手写好所有角色的 YAML / Prompt 配置 | 依赖中心总管按预定义拓扑派单 |
| **安全隔离与防刷屏门禁** | **平台代码级硬门禁**：③ 引擎调群发直接 `403 room_send_forbidden`；前台不带 `bash`；写文件强制 `grant_dir` 与乐观锁 | 单一进程拥有当前目录全部 shell 权限 | 运行在厂商云端沙箱，无法直接读写你本机私有工程 | 经常将 `bash` 直接挂给聊天主模型，且无代码级群发拦截 | 中心路由权限过大，缺乏单会话级目录授权与版本乐观锁 |
| **本地工具报错自愈** | **群外静默自愈**：`send(to: connection)` 转交专责维护 Bot 在群外改脚本热更新 + 维护群每日早会 | 在当前用户终端直接抛错并耗费主会话上下文尝试重试 | 无法访问或维护用户本机自定义 CLI 脚本 | 工具报错直接打断群聊，需人类开发者手动修脚本 | 报错回流中心节点，易污染主任务上下文 |
| **数据主权与模型绑定** | **100% 本地自托管（SQLite + 本地数据根）**：自由混搭本机 Codex 订阅、Grok、Claude 与 DeepSeek | 本地运行，但绑定单一厂商 CLI 生态 | 数据与会话保存在厂商云端，绑定单一模型生态 | 可自托管，但通常缺乏按 `快读 / 群聊 / 重活` 三级分表配模型 | 支持多模型，但缺乏原生 Codex `steer` 与三层精细记账 |
| **客户端体验** | **全自研原生四端（Protocol 3 实时同步）**：Web、Electron 桌面、iOS 26 SwiftUI、Android Compose | 终端 CLI / VS Code 插件 | 网页端 / X 客户端内嵌 | 借壳第三方 IM（Telegram / Discord / Slack），无原生气泡下快读摘要抽屉 | 网页管理台或 CLI，无全套原生移动端 |

---

## 4. 全原生四端与专项文档索引

### 📱 全自研原生四端（统一接入 Protocol 3 WebSocket 实时事件流）

1. **普通网页端（Web App · Paper Studio & Midnight Studio）**：温润纸感与深邃暗夜双主题，原生渲染气泡下方的 `① 快读摘要` 折叠抽屉、内联 `@Bot` 纸片徽章、引用回复链与后台执行过程抽屉。
2. **Electron 桌面端（Windows x64 / macOS Apple Silicon arm64）**：与正式网页共享实时视图，集成系统托盘、本机文件直开与自动发行包校验更新。
3. **iOS 26 原生客户端（SwiftUI · Liquid Glass）**：基于 iOS 26 原生 SwiftUI 与 Liquid Glass 材质打造，接入生产环境 APNs 远程推送，出门在外随时用手机查看家里主机上的 Codex 编译进度或在群里补一句话。
4. **Android 原生客户端（Kotlin · Jetpack Compose）**：全原生 Compose 渲染，完整支持 Bloub 矢量纸片动画头像、多群切换与离线战报附件预览。

### 🗂️ 仓库目录与专项权威文档

- **专项架构与运维文档**：[系统总体架构 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [模型路由表与 CLI 执行连接 (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [EggBot 自动组队与 17 种岗位 (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [Bloub 纸片几何头像 (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [四端发行与自动更新 (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [正式环境部署 (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md) · [日常运行维护 (`docs/OPERATIONS.md`)](docs/OPERATIONS.md)

```text
Summon-Bot/
├── bot/                    # 核心后端服务（Node.js 24 + SQLite）：三层会话调度、快读路由、EggBot、Protocol 3 网关
├── capabilities/           # 本机执行连接（Execution Connections）、CLI 适配器与工具自愈脚本
├── web/                    # 正式网页前端（Paper / Midnight UI）与 Bloub 纸片几何头像引擎（avatar-showcase）
├── desktop/                # Windows / macOS (arm64) Electron 桌面端工程与打包配置
├── ios/                    # SwiftUI 原生 iOS 26 客户端工程（Summon · org.lin0.summon）
├── android/                # Kotlin / Jetpack Compose 原生 Android 客户端工程
└── docs/                   # 架构、模型连接、EggBot、纸片头像、客户端发行与部署运维文档
```

</details>

<details>
<summary>
  <picture>
    <img src="docs/assets/readme-guide-en.svg" alt="Click to expand English Walkthrough & Full Architecture Specs" width="100%" />
  </picture>
</summary>

<br/>

<p align="center">
  <a href="#top"><img src="docs/assets/readme-story-1-en.svg" alt="Summon Bot Continuous Walkthrough (Part 1): From Vague Idea to EggBot Spawning & Fast-Read Triage" width="100%" /></a><br/>
  <a href="#top"><img src="docs/assets/readme-story-2-en.svg" alt="Summon Bot Continuous Walkthrough (Part 2): Parallel Codex Split, Live Steer, Staged Delivery & Memory" width="100%" /></a>
</p>

---

## 1. Why Summon Bot? Four Core Problems We Solve

1. **No Single-Thread Terminal Freeze (Chat vs. Heavy Engine Split)**
   - **The Pain Point**: In raw Codex CLI or Claude Code, saying *"start coding / run the build"* locks your chat window for minutes. You can't brainstorm Chapter 2 while it compiles, nor run a second task in parallel in the same thread.
   - **The Summon Solution**: **② Main Group Conversation** handles brainstorming, task dispatch, and final verified delivery, while heavy coding and CLI runs happen in parallel background **③ Standalone Execution Sessions (isolated Pi or external Codex threads)**. Foreground chat replies instantly while multiple Codex sessions build in the background.
2. **No Multi-Bot Chatter Chaos or Missed Mistakes (① Zero-Thinking Fast-Read Triage)**
   - **The Pain Point**: Traditional multi-agent frameworks either wake every expensive LLM on every message (wasting 90% tokens and spamming the room) or require explicit `@mentions` (so nobody stops a teammate from redundantly downloading a tool already on the machine).
   - **The Summon Solution**: Every new message first runs through each Bot's read-only, zero-thinking (`thinking: off`) **① Fast-Read Triage** pass. When unrelated, Bots return `route: quiet` and stop without waking their ② Main Chat model; when `Tool Bot`'s Fast-Read spots a teammate offering to download FFmpeg, it proactively wakes itself without an `@mention` to hand over the host's pre-registered `cli-ffmpeg` connection.
3. **Mid-Flight Live Steering Without Restart (`route: forward` / Native `steer`)**
   - **The Pain Point**: Halfway through a report build, you remember *"0-byte blank.png is a valid placeholder and use before/after columns."* In standard tools, you must hit `Ctrl+C` and restart or wait for a wrong build to finish.
   - **The Summon Solution**: Lead Bot's ① Fast-Read matches your follow-up to in-flight Session `#2`, bypasses ② Main Chat entirely, returns `route: forward`, and injects your words straight into the live Codex thread via native `steer`.
4. **Autonomous Team Assembly from Vague Ideas (EggBot Observation & Spawning)**
   - **The Pain Point**: Most multi-agent frameworks force you to author 5 role prompts and a workflow graph upfront, whereas real projects start with a vague *"I want to build a lightweight weekend game."*
   - **The Summon Solution**: Just brainstorm naturally with Lead Bot. **EggBot** silently observes room checkpoints by message stride; upon noticing that Lead Bot owns core code while nobody owns ongoing chapter economy balance, it autonomously calls `create_bot` to spawn `@LevelDesigner`, invites her into the room, and hands off context.

---

## 2. Six Core Architectural Innovations

### ① Three-Tier Session Pipeline & Code-Level Hard Gates

Summon Bot enforces discipline through runtime code gates rather than fragile prompt instructions:

| Tier | Responsibility | Permissions & Hard Code Gates | Default Model & Thinking |
| :--- | :--- | :--- | :--- |
| **① Fast-Read Triage**<br/>`fast_read` | Inspects every room message read-only, decides relevance/target session, and writes a 1-line factual summary. | **Zero write permissions** (no `room_send`, no `bash`), forced `thinking: off`. Outputs one of: `quiet` / `forward` / `main` / `new_session` / `cancel`. | `gpt-6.1-terra` / `deepseek-flash`<br/>**`thinking: off`** |
| **② Main Room Chat**<br/>`conversation` | The Bot's public persona: brainstorms, dispatches ③ sessions, verifies outputs, and delivers results quoting the user's ask. | Holds `room_send` and session dispatch privileges; multi-step turns collapse into a single clean reply. | `gpt-6.1-terra` / `deepseek-flash`<br/>**`thinking: high`** |
| **③ Execution Sessions**<br/>`pi_session` / `codex` | Writes code, runs CLIs, and verifies artifacts in isolated working directories (multiple concurrent sessions per Bot). | **Hard code gate blocks direct room messages** (`403 room_send_forbidden`), guaranteeing background tasks never spam the chat. | `gpt-6.2-sol` / `gpt-6.2-astra`<br/>**`thinking: xhigh / max`** |

- **Out-of-Context Summary Drawer (`room-message-summaries`)**: 1-line Fast-Read summaries sync via a dedicated WebSocket channel into the collapsible pill under each user bubble—**zero prompt pollution**.

### ② Stable Public Trunk + Private Turn Fork (90%+ Prompt Cache Hit Rate)

- During an active turn, public trunk `A` forks into private branch `A → B → C` holding mid-turn tool receipts and interjections so the active prefix remains append-only;
- Once final reply `D` is published, the next turn collapses history into clean public trunk `A → C → D`, sustaining **90%+ prompt cache hit rates**.

### ③ 5-Layer Persona & Compression-Proof Material Index (`material_index_ref`)

1. **Layer 1 · Hard Guardrails**: Code-enforced directory grants (`grant_dir`), optimistic concurrency (`expected_revision`), and ③ room-send blocks.
2. **Layer 2 · Current Turn Ask**: Explicit instructions in the active or quoted message.
3. **Layer 3 · Room Conventions**: Persistent room rules stored in `material_index_ref` (`applies_to: room`), **pinned across context compression**.
4. **Layer 4 · Individual Cross-Room Memory**: Personal notes (`individual_note`) and daily reflections accumulated across rooms.
5. **Layer 5 · 17 Built-in Role Presets**: Lead, EggBot, Tool Onboarding, Level Designer, Architect, Auditor, and more.

### ④ Local Tool Lifecycle & Out-of-Band Self-Healing

- **Tool Onboarding Bot**: Probes host CLIs on startup, runs smoke tests, registers execution connections, and proactively offers them in chat when teammates need a tool.
- **Dedicated Maintainer Bot & Out-of-Band Repair**: Every connection binds to a Maintainer Bot. When a CLI upgrade breaks flags, tasks call `send(to: connection)` to notify the Maintainer Bot, which patches and hot-reloads the wrapper script **outside the project room**.
- **Built-in Bot Maintenance Room**: Reviews daily `connection_usage` ledgers in automated standups to standardize tool wrappers.

### ⑤ Purpose-Based Model Routing & SQLite Usage Ledger (`usage.sqlite`)

- Reuse your existing local **Codex subscription, Grok, Claude, or DeepSeek API keys**, mapping `① Fast-Read`, `② Main Chat`, and `③ Heavy Coding` to optimal models and thinking levels while attributing every token in `usage.sqlite`.

### ⑥ Bloub Vector Paper Avatar Engine

- Powered by the built-in `PaperRig` geometry engine (`squircle`, `galet`, `nuage`, `triangle`, etc.) with 3D perspective eye matrices and live expressive motions (`idle`, `curieux`, `heureux`, `attentif`).

---

## 3. Competitive Comparison: Why Summon Bot vs. Raw Codex & Other Agent Platforms

| Dimension | **Summon Bot** | Raw Codex / Claude Code | Grokbot (xAI) | OpenBot / Hermes Bot | DSH SuperAgent |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Form Factor** | **Self-hosted multi-Bot group workspace** orchestrating Codex/Pi as ③ engines | Single-threaded terminal / IDE coding assistant | Vendor-hosted cloud assistant | Multi-character bot framework on Telegram/Discord | Central-router multi-agent system |
| **Chat While Coding?** | **Zero freeze**: ② Main Chat and ③ background Codex run in parallel; chat replies instantly | **Single-window freeze**: long tool runs block the active terminal thread | Cloud queue bound; no local multi-process duplexing | Mostly serial tool execution; chat stalls during heavy runs | Central router waits on sub-agent callbacks |
| **Mid-Flight Steering** | **① Fast-Read direct forward (`route: forward`)**: native `steer` into running Codex thread | Must press `ESC / Ctrl+C` to abort and restart, or wait and rework | Cannot hot-steer local in-flight build threads | Queues for next turn or triggers duplicate runs | Re-dispatches through central router with high latency |
| **Triage & Proactive Rescue** | **Kernel ① Fast-Read (`thinking: off`)**: `quiet` saves 90% tokens; rescues tool mistakes without `@mention` | Single agent only | Single primary agent or command-triggered | Relies on prompts or forced `@mention`; either spams or misses mistakes | Central router assigns turns; peers cannot self-initiate rescue |
| **Team Assembly** | **EggBot autonomous spawning**: observes vague chat and calls `create_bot` when a role gap appears | Manually open multiple terminals and copy-paste context | Fixed presets or manual mode switching | User must hand-write YAML/prompts for all roles upfront | Dispatches across pre-configured static topology |
| **Security & Hard Gates** | **Code-level hard gates**: `403 room_send_forbidden` on ③ engines, no `bash` on chat router, `grant_dir` & revision locks | Single process holds full shell access | Runs in vendor cloud VM without direct local repo access | Often attaches `bash` directly to chat LLM without code gates | Broad central router privileges without per-session directory grants |
| **Tool Self-Healing** | **Out-of-band self-healing** via `send(to: connection)` to Maintainer Bot + daily standup room | Errors dump into user terminal and consume main context tokens | Cannot inspect or repair local custom CLI wrappers | Breaks chat flow until human manually edits script | Errors bubble back to central router, polluting task context |
| **Data Ownership & Models** | **100% local self-hosted (SQLite + local data root)**; mix Codex, Grok, Claude & DeepSeek | Local execution, locked to single vendor CLI | Cloud-stored sessions locked to single vendor | Self-hostable, lacks 3-tier purpose model routing table | Multi-model, lacks native Codex `steer` & 3-tier SQLite ledger |
| **Client Ecosystem** | **4 First-Party Native Clients (Protocol 3)**: Web, Electron Desktop, iOS 26 SwiftUI, Android Compose | Terminal CLI / IDE plugin | Web / X app embed | Borrowed 3rd-party IM UI (Telegram/Discord) without summary drawers | Web dashboard or CLI; no native mobile apps |

---

## 4. Four First-Party Clients & Documentation Index

### 📱 Four Native Clients (Real-Time Sync via Protocol 3 WebSocket)

1. **Web App (Paper Studio & Midnight Studio)**: Warm Paper and Midnight themes with native under-bubble `① Fast-Read Summary` drawers, inline `@Bot` paper badges, reply chains, and background execution drawers.
2. **Electron Desktop (Windows x64 / macOS Apple Silicon arm64)**: Shares the live formal web view with native tray integration, local file opening, and automated release updates.
3. **Native iOS 26 Client (SwiftUI · Liquid Glass)**: Built with iOS 26 SwiftUI Liquid Glass and production APNs push notifications—check desktop Codex builds or steer a task from your phone anytime.
4. **Native Android Client (Kotlin · Jetpack Compose)**: Native Compose UI with Bloub vector paper avatar animations, room switching, and offline HTML report previews.

### 🗂️ Repository Map & Deep-Dive Documentation

- **Core Specs**: [System Architecture (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) · [Model Routing & CLI Connections (`docs/MODEL_CONNECTIONS.md`)](docs/MODEL_CONNECTIONS.md) · [EggBot & 17 Built-in Roles (`docs/EGGBOT.md`)](docs/EGGBOT.md) · [Bloub Vector Paper Avatars (`docs/PAPER_AVATARS.md`)](docs/PAPER_AVATARS.md) · [Client Releases & Auto-Update (`docs/CLIENT_RELEASES.md`)](docs/CLIENT_RELEASES.md) · [Formal Deployment (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md) · [Operations (`docs/OPERATIONS.md`)](docs/OPERATIONS.md)

```text
Summon-Bot/
├── bot/                    # Core backend (Node.js 24 + SQLite): 3-tier scheduler, Fast-Read router, EggBot, Protocol 3 gateway
├── capabilities/           # Local Execution Connections, CLI adapters, and self-healing scripts
├── web/                    # Formal web frontend (Paper / Midnight UI) & Bloub paper avatar engine (avatar-showcase)
├── desktop/                # Windows / macOS (arm64) Electron desktop app & packaging config
├── ios/                    # Native SwiftUI iOS 26 client (Summon · org.lin0.summon)
├── android/                # Native Kotlin / Jetpack Compose Android client
└── docs/                   # Architecture, model connections, EggBot, paper avatars, releases, and operations docs
```

</details>
