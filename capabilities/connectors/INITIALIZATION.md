# 初始化 Summon Bot 的 CLI 执行连接

Pi 使用当前工作区已配置的模型完成初始化。模型连接用于 Pi 的推理，执行连接用于在宿主机调用外部 CLI。CLI 使用自己的本机登录或由宿主绑定的凭据引用。保留配置中的凭据引用，使用工具读取经过处理的帮助和诊断，避免把凭据内容放进任务、命令参数、脚本或输出。

## 从当前安装开始

1. 用 `find` 和 `read` 查看目前可用的执行连接。能满足本次工作的现有连接可以直接用 `open_session`。
2. 用 `initialize_execution` 的 `discover` 查询内置连接器、实际找到的可执行路径和本次授权范围。用 `guide` 读取相应连接器文档，再用 `inspect` 看安装路径、版本、帮助和探测到的选项。探测其他 CLI 时传 `command` 或 `executable`。`help_topic` 可读取特定的子命令帮助。
3. 要启用已有连接器，使用 `register` 提交连接器 ID 和实际可执行路径。安装版本的变化优先用能力来判断，例如帮助列出的输入方式、输出模式或续接参数。可用 `source` 查看适配源码，或用 `documentation` 按需查官方文档并和本机帮助比对。联网失败时继续使用本机证据和内置资料。
4. 如果本机 CLI 只需调整参数，用 `register` 的 `adapter.arguments` 保留内置连接器。CLI 采用不同的输入或事件格式时，再用 `adapter.recipe` 配置映射。对未内置的 CLI，可以使用宿主选定的程序或已有直参授权的执行连接。后续修正时，`connection` 填写 `discover` 返回的连接 ID 字符串，登记时带上当前 `revision`。用 `source` 读取已保存的参数、映射或脚本。
5. 需要执行时，读取登记返回的连接，调用 `open_session`，其 `engine` 为连接 ID，`input` 为文本或 `{ "text": "工作要求" }`。`workspace` 直接填写 `find` 返回的工作区 ID 字符串或已授权的绝对目录路径。私有初始化已选定工作区时，打开私有原生 CLI Session 可以省略 `workspace`。确认进度和结果时，读取 Session 以及它返回的任务、输出和实际产物。

## 接口和能力

启动至少需要一个可独立启动的 CLI、非交互输入、可观察的退出或终态及实际输出。具体工作根据 CLI 自身许可使用文件、命令或其他工具。Summon 将调用身份、项目目录、原生进程和返回记录固定在 Session 上。同一连接可使用现有授权范围内可写的项目。以实际工作目录传递任务，同时保留供应商权限规则和项目设置。精确文件范围与只读工作采用能明确执行该范围的连接。

宿主明确传入 `executables` 时，Pi 发现、登记、启动和续接都遵循选定的可执行路径。该范围随父子 Session 传递。空数组表示这次工作只使用 Pi。CLI 内部工具运行仍遵循各 CLI 的原生许可和隔离能力。

如果 CLI 公开原生 Session ID 和能指定此 ID 的重新进入方式，将该 ID 发给 Summon。在 `read` 返回实际 `next` 目标时，用 `send_input` 的 `next`、当前 `control_version` 和对应 `input_target` 提交下一轮。宿主用上一次观测的 ID 续接。用户暂停后按实际 `resume_ref` 恢复控制。还在运行的输入、审批、历史读取和脱离进程后的状态核对都以连接实际支持的功能为准。

区分原生任务输出、工具拒绝、进程退出和用户成果。CLI 返回终态后，根据真实文件、工具输出和要求判断任务是否完成。发现断连、终态未确认或者部分写入时，先观察原任务，再决定续接方式。

## 输入和事件映射

用 `inspect` 查看本机 `--help`、当前已登记的参数和连接器管理的选项。向 `register` 提交 `adapter.arguments` 时，`common` 里的参数用于开启和续接，`start` 只用于开启，`resume` 只用于续接。每项使用 `--option` 或 `--option=value`。提交的组替换该组已保存的参数，省略的组沿用原值，传空数组会清除该组。内置连接器继续生成必要的非交互、输出格式、会话 ID 和工作目录参数，并处理进度、终态和控制。对曾使用完整映射的内置 CLI，可在同一连接登记这些参数并恢复内置解析。

`adapter.recipe.args` 是直接传给已绑定程序的参数数组。可以填 `{{text}}` 或 `{{prompt_file}}`，也可以用 `stdin: true` 传入文本。`output` 支持 `plain`、`json` 或 `jsonl`。在 JSON 中，`session_id`、`progress`、`result`、`error` 可填写如 `data.sessionId` 的字段路径。对逐行 JSON，用 `complete_when` 的 `path` 和 `equals` 识别真实终态。若 CLI 区分成功和失败，可再用 `success_when`。支持续接时写 `resume_args`，其中 `{{session_id}}` 会替换为此前确认的原生 ID。

普通任务发现接口变化时，可用 `initialize_execution` 查阅并修正该 Pi 已有授权的连接。登记时保留它绑定的执行文件、项目范围和协议。只更新同一连接的适配时，可以从已结算且有确认 ID 的 Session 继续。

## CLI 专责维护

接入 CLI 时通过 `find` 或 `read` 查看已登记连接的 `maintainer`。有负责人时按该 Bot 引用复用。没有负责人时，根据当前授权使用 `create_bot` 选择 `role_id: "catalog-maintainer"` 和这个 `role_connection_id`，或用 `configure_bot` 把职责分给有权管理的现有 Bot。为维护工作单独选用当前工作区已获准的模型。一个连接同时只有一个当前负责人。

在宿主授权的初始化会话中，`initialize_execution` 的 `grant_access` 可以对本次范围内的连接给指定 Bot 授权。传入实际的 `connection`、当前 `revision`、目标 `bot` ID 和 `access`。`use` 授权调用，`repair` 同时授权在同一绑定范围内探测与维护。已有调用授权和原初始化身份随重复登记保留。依赖、直参和工作目录使用各自的授权。宿主也可用现有连接设置的 `allowed_bot_ids` 和 `repair_bot_ids` 向同工作区的 Bot 授权。连接已可调用时，正常执行可以继续。

维护 Bot 可经同一工作区的普通房间收请求。需要故障通知时，用 `set_wakeup` 设置该 Bot 的 `event_or_time`，例如 `{ "kind": "event", "type": "connection.failure", "ref": { "kind": "connection", "id": "实际连接 ID" } }`。通过 `find` 查看该 Bot 的现有 `wakeup` 后再调整。宿主确认的连接级启动故障会带上连接引用、绑定版本、原失败状态和错误类别。事件沿现有投递和收件记录进入维护 Bot 的私有运行，接收和读取时复核当前连接绑定。原任务输入、输出、工作目录和凭据按原授权保留。

对已有原生方法的原始 CLI，可读取登记方法，获得修复授权后可 `inspect` 实际帮助、用 `register` 和当前连接修订更新检测版本。原生方法的参数、文件和环境配置由宿主通过现有连接设置修改。Codex 协议连接从类型选择内置适配，检测时保留原本的执行文件、项目范围和用户的模型设置。维护者可用 `save_file` 保存有来源的适用方法，在获准的房间用 `send` 分享结果。

## 适配脚本约定

接口需要脚本时，在 `adapter.source` 提交 Node.js ES 模块，并在 `adapter.runner` 指定一个已有直接参数权限的原生解释器连接。解释器和目标 CLI 均遵循此工作的执行范围、调用者及目录授权。需要续接的脚本可声明 `adapter.resume`。

脚本进程的工作目录是获准的项目。stdin 会提供一行 JSON，其中 `summonStart.executable` 为已绑定的程序路径，`text` 为本轮输入，`sessionId` 为先前已确认的原生 ID 或 `null`。用参数数组直接启动该路径，再把任务内容交给 CLI 的输入接口。脚本的输出用于持久化会话观测。

- 用一行 JSON `{"summonEvent":{"type":"session","sessionId":"native-id"}}` 传递 CLI 确认的会话 ID。有 `summonStart.sessionId` 时，应核对 CLI 是否恢复同一会话。
- 进度用 `type: "progress"` 及 `text`，可附 `itemId` 和 `phase`。保留真实的原生权限或工具错误。诊断可写入 stderr。
- 结果用 `type: "result"` 及 `text`，CLI 已确认时加 `confirmed: true`。
- 结束时发出 `type: "outcome"`，按观测填写 `status`，可用 `completed`、`failed`、`stopped`、`unknown`、`not_submitted`、`unsupported`，并可携带 `error`。运行前失败和执行期间失联应分别记录。

脚本使用已登记解释器的权限。普通任务内修正脚本时沿用同一个解释器授权。用 `read` 和现有 Session 工具查看 CLI 诊断、进程状态及实际控制目标。
