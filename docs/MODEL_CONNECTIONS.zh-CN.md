[English](MODEL_CONNECTIONS.md) | [简体中文](MODEL_CONNECTIONS.zh-CN.md)

# 模型路由与执行连接

Summon Bot 将**模型连接（供 Pi 思考与对话使用）**与**外部执行连接（供后台执行重活与调用本机/远端工具使用）**清晰分离。所有连接定义、凭据与资源上限均保存在正式数据根的私有配置中，绝不进入 Bot 对话历史或源码仓库。

## 1. 模型连接与凭据存储

- **配置文件**：
  - `config/model-connections.json`（Schema v2）：保存模型连接列表、默认连接 `activeId`、用途默认模板 `purposeDefaults`、单连接用途覆盖 `connectionPurposes` 及外部 Codex 推荐组合。
  - `config/model-credentials.json`：保存独立的 API Key 与设备登录凭据。
  - `config/runtime.env`：按显式环境变量名引用已有凭据。
  - `config/model-usage.json` 与 `usage.sqlite`：分别缓存供应商返回的额度窗口快照，以及按每次真实模型请求独立记账的 Token 账本。
- **支持的模型连接类型**：
  - **Codex 订阅（`kind: "codex"`）**：支持导入正式主机 `~/.codex/auth.json`（或 `CODEX_HOME`）的本机登录，走 `openai-codex-responses` 协议。
  - **Grok 订阅（`kind: "grok"`）**：支持导入本机 `~/.grok/auth.json`（或 `GROK_HOME` / `GROK_AUTH_PATH`），并自动对齐本机 CLI 版本头。
  - **通用 API（`kind: "api"`）**：支持 `deepseek`、`openai`、`anthropic`、`xai` 及任意 `openai-compatible` 端点，协议覆盖 `openai-completions`、`openai-responses` 与 `anthropic-messages`。

## 2. 按用途分层模型路由表

每个 Bot 的不同运行阶段对延迟、成本与推理深度的要求不同，平台将模型用途划分为 3 档（`modelPurposes`）：

| 用途 (`purpose`) | 运行阶段 | 默认设计思路 |
| --- | --- | --- |
| `fast_read` | 群消息快读收件（`quiet` / `main` 分流与实时进度文案） | 优先低延迟、关闭思考（`thinking_level: "off"`），大幅降低旁听成本 |
| `conversation` | 群主对话与私聊（拆解需求、决策、公开发言与派工协调） | 均衡推理能力与响应速度（默认 `thinking_level: "high"`） |
| `pi_session` | 后台独立 Pi 执行会话（复杂分析、多文件读写与子任务编排） | 选用更强模型或更高思考深度（`high` / `max`） |

### 模板默认配置与覆盖层级

平台为 5 类常见模型来源（`deepseek`、`openai`、`codex`、`anthropic`、`grok`）内置可编辑的 `purposeDefaults` 模板，并支持在网页设置中按以下优先级逐层定制：

1. **Bot 级自定义（`mode: "custom"`）**：为单个 Bot 指定主连接、模型 ID、思考深度，或按 `purposes.fast_read` / `conversation` / `pi_session` 分别覆写（支持跨不同连接混搭，例如用 DeepSeek 跑快读、用 Codex 跑主对话与独立执行）。
2. **跟随指定连接（`mode: "follow_connection"`）**：按该连接的 `connectionPurposes` 或其所属分类的 `purposeDefaults` 解析三档用途。
3. **跟随实例默认（`mode: "follow_default"`）**：自动跟随实例当前 `activeId` 连接及其用途配置（新建预置 Bot 与群主控的默认模式）。

> 已启动的 Pi 会话在创建时冻结其 `connection_id`、`model_id`、协议与思考深度绑定；若后续连接类型或底层协议变更，旧执行会话不会静默切换，而是显式报 `403 model_binding_changed`。故障与额度耗尽同样明确回报，不做隐蔽回退。

## 3. 外部执行连接与内置连接器

除嵌入式 `pi` 会话外，Bot 可通过 `open_session` 调用登记在平台的外部执行连接，由网关在正式主机按原生协议驱动：

| 连接类型 | 说明 |
| --- | --- |
| **Codex (`codex`)** | 内置 `codex app-server` 协议连接器，保留原生 thread / turn、实时 `steer`、输出流、历史回读与审批交互。在 `model-connections.json` 的 `externalEngines.codex.recommended` 中维护可编辑的 `(model, effort)` 推荐组合。默认 `sandbox: "danger-full-access"`、`approval_policy: "never"`（可在单次 `open_session` 或连接设置中按需覆写）。详见 [Codex 连接器说明](../capabilities/connectors/codex.md)。 |
| **Grok Build (`grok-build`)** | 驱动本机 `grok` 无头执行，支持结构化流式输出与 `--resume` 续接。详见 [Grok Build 连接器说明](../capabilities/connectors/grok.md)。 |
| **Claude Code (`claude-code`)** | 驱动本机 `claude --print` 流式执行与 `--resume` 续接。详见 [Claude Code 连接器说明](../capabilities/connectors/claude.md)。 |
| **本地 CLI (`cli`)** | 任意本机命令行程序或自定义 Node 适配脚本，支持只读探测（`--version` / `--help`）、固定方法登记与进程级 `stop_session` / `send_input`。 |
| **SSH (`ssh`)** | 远端服务器受控命令执行连接（`capabilities/services/ssh-binding.mjs`）。 |
| **MCP (`mcp`)** | 支持官方 MCP stdio 与 Streamable HTTP 传输，自动完成工具发现与调用。 |
| **HTTP (`http`)** | 直接登记 REST / HTTP 接口与方法映射，无需额外包装成 MCP。 |

## 4. 工具接入、维护闭环与用量限额

- **自助接入**：宿主可通过网页设置或 `POST /api/connections/initialize` 启动私有初始化会话；具备权限的 Bot（特别是 **接口 Bot**）使用 `initialize_execution` 发现并探测本机工具、登记连接与方法，并绑定专责的 `catalog-maintainer` Bot。
- **群外自修闭环**：任何 Bot 在使用执行连接遇到可核实故障（例如 CLI 升级导致参数变更）时，调用 `send` 发往 `{ kind: "connection", id }` 并附带失败调用引用；对应的 `catalog-maintainer` Bot 在后台核查修复后，用 `reply_to` 回报结果（`repaired`、`blocked` 或 `need_info`），原任务收到回执后无缝继续，不打扰群聊前台。
- **并发与用量治理**：网页设置可调整并发模型/外部调用数、队列容量与宿主资源上限；“Token 统计”页面支持按日期、Bot、单聊/群聊、来源、用途、模型维度汇总真实调用，并与供应商额度窗口对照展示。
