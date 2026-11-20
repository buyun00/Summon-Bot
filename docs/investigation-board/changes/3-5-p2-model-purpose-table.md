# P2 · 可编辑的用途模型与思考深度配置表

**2026-11-20 · 已定稿并完成代码制作（待与后续批次合并部署与验证） · 拆分批次 2 / 5。** 前置依赖：无。所属总纲：[单 Bot 内部对话与模型配置表 · 制作总纲](3-5-single-bot-core-outline.md)。

本篇把“按连接和用途配置模型与思考深度”做成独立可编辑、可生效、可验证的配置能力，并把当前代码里缺失的模型能力元数据、授权联动和旧 Bot 迁移问题一次收清。

## 本篇范围与边界

- **本篇要做**：可编辑的用途模型表（存储、API 与网页设置页）、模型能力元数据补齐、Bot/Pi/外部 Codex 的查表绑定与生效时机、跟随默认与显式固定区分、模型授权联动、`usage.sqlite` 用途分类预留。
- **明确不做**：不启用 ① 快读运行（本篇先把 ① 的表项落库可配，待 P3 启用）；不做模型每日查新、接口 Bot 自动升级提案与运行中旧会话迁移（后置专题）。[后续模型维护讨论](3-5-single-bot-conversations.md#后续优化聊天接口-bot-和各引擎接口-bot-分别维护分别提案)

## 当前现状与发现的问题

核查 [connections.mjs](D:/Relay-Bot/bot/src/agent/connections.mjs:35)、[service.mjs](D:/Relay-Bot/capabilities/models/service.mjs:64)、[bot-management/service.mjs](D:/Relay-Bot/capabilities/bot-management/service.mjs:88)、[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:454) 与 [platform.mjs](D:/Relay-Bot/capabilities/platform/platform.mjs:647) 后，发现五处必须在设计阶段定清的事实：

1. **新型号元数据缺失**：当前内置目录和 `openAIExplicitCacheModels` / `openAILongContextModels` 最高只包含到 `gpt-6.1-sol` / `gpt-6.1-terra`，尚无 `gpt-6.2-sol`、`gpt-6.2-astra`。若直接填入表内给独立 Pi 使用，会静默降级为 128K 上下文、8K 输出、关闭显式缓存且丢失图片输入能力。
2. **GPT API 与 Codex 订阅能力并不一致**：`terraModel` 与 `thinkingLevelMap`（支持 `off` 映射 `none`）目前仅对 `kind: 'api', provider: 'openai', api: 'openai-responses'` 生效（[connections.mjs](D:/Relay-Bot/bot/src/agent/connections.mjs:69)）。Codex 订阅（`openai-codex-responses`）内置目录中目前不含 `gpt-6.1-terra`，`gpt-6.1-sol` 的思考档亦未列 `off`/`max`。
3. **当前存在多种连接且历史配置混杂**：正式配置中除 DeepSeek、OpenAI API、Codex 订阅外，还有 Grok 订阅，且同厂商可建多条连接；`model-connections.json` 中还留有旧字段 `fastId` 与单连接级的单一 `model` / `thinkingLevel`。
4. **旧 Bot 全部写死了具体模型**：现版 `models.selectBinding()` 在创建 Bot 时就把当时的 `activeId` 和具体 `model.id` 固化写入 `bot.model`，没有“跟随默认”标记；且 `open_session(engine: 'pi')` 直接继承 `bot.model`，未独立取 ③ 独立 Pi 配置。
5. **模型授权校验强耦合**：[bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs:456) 要求目标 `connection_id` 必须在 `platform-access.model_ids` 内。若 ① 单独指定另一个快模型连接或默认表换连接，缺少授权同步会直接报 `403 connection_forbidden`。

## 改造方案

### 1. 用途模型表结构与首版默认值

新增可编辑配置表，按**聊天连接（含厂商默认模板与单连接覆盖）× 用途**保存 `{ model, thinking_level }`；外部执行引擎另维护允许的 `(model, effort)` 组合列表。凭据继续沿用现有连接管理。

#### 聊天与独立 Pi 用途表（首版）

| 连接类别 | ① 快读（P3 启用） | ② 群主对话及其本轮 fork | ③ 独立 Pi |
| --- | --- | --- | --- |
| DeepSeek API | `deepseek-flash` · `off` | `deepseek-flash` · `high` | `deepseek-flash` · `max` |
| GPT API（`openai-responses`） | `gpt-6.1-terra` · `off` | `gpt-6.1-terra` · `high` | `gpt-6.2-sol` · `high` |
| Codex 订阅（`openai-codex-responses`） | `gpt-6.1-terra` · `off` | `gpt-6.1-terra` · `high` | `gpt-6.2-sol` · `high` |
| 其他连接（如 Grok 订阅、Anthropic、自定义 API） | 默认沿用连接模型 + 支持则 `off`，不支持则用连接默认 | 沿用连接默认模型与思考档 | 沿用连接默认模型与支持则 `high`（可按单连接覆写） |

#### ③ 外部 Codex 允许组合表（独立于聊天连接）

- `gpt-6.2-sol`：`xhigh`、`max`
- `gpt-6.2-astra`：`high`、`xhigh`、`max`
- 任意聊天连接的 Bot 都可把工作派给外部 Codex；② 首次派工时根据工作难度在允许组合内选择。
- **暴露方式**：通过 `read(connection)` 返回该 Codex 连接当前允许的 `(model, effort)` 组合（以及单连接显式覆盖如有），不硬写入 ② 的稳定系统提示词，避免改表使全量 ② 缓存失效。

### 2. 模型能力元数据与保存/运行校验

- 补齐 `connections.mjs` 中新上市型号（如 `gpt-6.2-sol`、`gpt-6.2-astra` 及核实后的 Codex 订阅型号）的上下文窗口、最大输出、多模态输入、显式缓存支持和原生思考档映射，避免静默降级。
- **配置保存时校验**：在网页端或 API 编辑用途表时，按目标连接实际支持的型号与原生思考档做校验；不支持时直接返回具体原因，防止错误配置导致群内 Bot 集体启动失败。
- **运行时错误反馈**：上游停用型号或账号权限变化导致运行时不支持所选组合时，返回具体连接、型号、档位及上游原因——派工时供 ② 重新选择，对话启动失败时在界面清晰展示原因给配置者。
- **取代旧字段**：新用途表生效后，按一次性转换清理 `model-connections.json` 中被取代的 `fastId` 等过时入口，不保留兼容回退分支。

### 3. Bot 绑定模式、授权联动与生效时机

- **三种创建路径统一**：系统配套（EggBot、接口 Bot）、Pi `create_bot`、用户手建共用同一查表逻辑。
- **区分“跟随默认”与“显式固定”**：
  - Bot 配置明确区分：`跟随连接用途默认表`、`仅固定连接但用途跟表`、`按用途显式覆盖`（支持单独给 ① 快读指定另一条快模型连接）。
  - 独立 Pi 在 `open_session(engine: 'pi')` 创建时，按发起 Bot 的聊天连接查表读取 **③ 独立 Pi** 行并锁定到该 Session 的 `model_binding`（显式覆盖优先）。
- **生效时机**：
  - 跟随默认的 ①、② 在**下一轮**自动取最新表值；
  - 正在运行的 fork、已创建的独立 Pi 和已启动的外部 Codex 线程继续保持开工时的绑定（[connection-launch.mjs](D:/Relay-Bot/capabilities/services/connection-launch.mjs:48) 维持不变）。
- **授权联动**：允许宿主用户在模型设置中配置“跟随默认表的 Bot 自动获得表内指定聊天/快读连接的使用权”，或在改表涉及新连接时一并提示并授予对应 `platform-access.model_ids`，避免切表后出现大面积 `403 connection_forbidden`。
- **用量统计预留**：在 [engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs:78) 与 [usage.mjs](D:/Relay-Bot/bot/src/agent/usage.mjs) 中预留 `fast_read` 用途分类（连同既有 `conversation`、`pi_session`、`compression`、`material_consolidation`），便于后续按用途独立核对消耗与缓存。
- **界面入口**：先在网页端“模型与引擎设置”提供用途模型表的查看与编辑（含外部 Codex 组合表及 Bot 跟随/固定状态切换），Electron 桌面端复用网页，网页定稿后再同步 iOS/Android。

## 已定稿拍板项（2026-11-20 确认）

1. **DeepSeek 独立 Pi（③）的首版型号（已确认）**：统一使用 `deepseek-flash` · `max`，不使用 `deepseek-v4-pro`。
2. **GPT API 与 Codex 订阅配置（已确认）**：两者在表中分列独立行便于后续调整，首版默认值采用完全相同的模型与思考深度（① `gpt-6.1-terra / off`、② `gpt-6.1-terra / high`、③ `gpt-6.2-sol / high`），并同时补齐两协议的 `gpt-6.1-terra` / `gpt-6.2-sol` / `gpt-6.2-astra` 元数据。
3. **既有旧 Bot 清理策略（已确认）**：正式库中的旧 Bot 全部无用，不再保留迁移兼容，待统一停机部署时一次性清理全部旧 Bot（同步清理其房间成员引用与旧连接维护者绑定、移除 `fastId`），由新版启动后自动按 `follow_default` 生成全新的默认 `EggBot` 与 `接口 Bot`。
4. **外部 Codex 组合表约束力度（已确认）**：采用**软推荐**模式，配置落在 `model-connections.json` 的 `externalEngines.codex.recommended` 中（支持网页编辑或直接替换配置文件）；通过 `read(connection)` 动态返回给 ② 主对话按任务难度自行选择，既不拦截用户显式点名，也不改动 ② 稳定系统提示词前缀，保持前缀缓存命中。

## 已完成代码落点

- [connections.mjs](D:/Relay-Bot/bot/src/agent/connections.mjs)：补齐 `gpt-6.1-terra`、`gpt-6.2-sol`、`gpt-6.2-astra` 在 `openai-responses` 与 `openai-codex-responses` 上的完整元数据（窗口、输出上限、图片输入、思考档映射与 OpenAI 显式缓存）；新增用途表默认值、目录规范化（清理 `fastId`）、`validateModelPurpose`、`resolveConnectionPurpose`、`resolveBotModelSelection` 与 Codex 软推荐默认表。
- [model.mjs](D:/Relay-Bot/bot/src/agent/model.mjs) · [provider.mjs](D:/Relay-Bot/bot/src/agent/provider.mjs)：`bindModel` 支持按 `purpose` 解析 `follow_default` / `follow_connection` / `custom` 绑定；流式失败诊断附带连接名、型号与请求思考档。
- [models/service.mjs](D:/Relay-Bot/capabilities/models/service.mjs) · [api.mjs](D:/Relay-Bot/capabilities/gateway/api.mjs)：启动初始化规范化为 schemaVersion 2 并移除 `fastId`；新增 `savePurposes` 与 `POST /api/model-settings/purposes`（保存时按模型能力强校验思考档）；支持 `resolveForBot`、`resolveAllForBot`、`codexRecommendations`、`effectivePurposes`，删连接时自动清理相关覆写。
- [contract.mjs](D:/Relay-Bot/capabilities/platform/contract.mjs) · [bot-management/service.mjs](D:/Relay-Bot/capabilities/bot-management/service.mjs) · [platform.mjs](D:/Relay-Bot/capabilities/platform/platform.mjs) · [bot.mjs](D:/Relay-Bot/bot/src/runtime/bot.mjs) · [engine.mjs](D:/Relay-Bot/bot/src/agent/engine.mjs)：三种创建入口统一默认 `{ mode: 'follow_default' }`；`modelAccessBlocker` 接入 `autoGrantPurposeConnections` 授权联动；`open_session(engine: 'pi')` 查表锁定 ③ `pi_session`；`read(connection)` 为 Codex 动态返回 `recommendation_mode: 'soft'` 与实时 `recommended_combinations`；`engine.mjs` 预留 `fast_read` 用途并在稳定通用协议中提示 ② 通过 `read(connection)` 读取 Codex 软推荐。
- [models.js](D:/Relay-Bot/web/frontend/models.js) · [models.css](D:/Relay-Bot/web/frontend/models.css) · [app.js](D:/Relay-Bot/web/frontend/app.js) · [usage.js](D:/Relay-Bot/web/frontend/usage.js)：网页端新增用途模型默认表编辑、单连接用途覆写、外部 Codex 软推荐组合编辑、Bot 模型绑定模式切换（跟随默认 / 固定连接跟表 / 显式固定与按用途覆盖）及 `usage` 新用途中文标签。

## 独立验证清单

部署到唯一正式环境 `http://127.0.0.1:8787` 后，可独立核对以下可观察表现：

1. **改表即时生效与校验**：在网页端修改 ② 与 ③ 的模型/思考档并保存，输入不支持的思考档能收到具体拒绝原因。
2. **跟随默认 vs 显式固定**：跟随默认的 Bot 在下一轮群聊按表内 ② 行发起请求（通过 `usage.sqlite` 核对 `sentModel`、`sentReasoningEffort` 与上下文窗口未降级）；显式固定模型的 Bot 不受改表影响。
3. **独立 Pi 与外部 Codex 绑定**：② 新开独立 Pi 时取表内 ③ 行并锁定，改表后已开 Pi 仍用原绑定、新开 Pi 用新值；`read` Codex 连接返回 5 组可选组合，② 按难度择一启动并锁定线程。
4. **三种创建入口一致**：检查系统预置、Pi 创建和手动新建的 Bot 均正确继承默认表且无授权 `403` 错误。
5. **非目标连接不报错**：使用 Grok 订阅或其他 API 连接时按回退规则正常运行，不因强传 `off` 报错。
