---
name: summon-execution-onboarding
description: 发现、复用、登记和维护本发行版 Summon Bot 的 CLI、SSH、HTTP 与 MCP 执行连接。
---

# Summon Bot 执行连接接入

用 `find {kind:"connection"}` 和 `read` 核对当前可访问的连接、`revision`、可用方法、`can_use`、`can_repair` 和 `maintainer`。随后用 `initialize_execution` 的 `discover` 按 `query`、`command` 或绝对 `executable` 查实际安装。给出已有 Session、连接或群工具事件的 `target` 可核对执行地点。发现结果的 `environment` 和 `scope` 对应该观察的主机、查找范围和工作目录。远端没有相应观察时，反馈需要远端资料。用 `discover.required_version` 对照确切的登记版本字符串。

用 `initialize_execution {action:"inspect",target:{kind:"connection",id:"原连接 ID"},help_topic:"子命令"}` 探测已登记本机 CLI 的实装版本和帮助，也可直接传 `connection` ID。两个字段同时传时必须指向同一连接。工具使用该连接的绑定路径，无需再填 `command` 或 `executable`。`observations` 记录各次探测的退出状态。Session 和群工具事件只提供执行地点。探测原连接需要能读取和使用该连接，以及原连接的维修权或宿主对同一程序的探测授权。若探测因授权被拒绝，先用 `read` 核对原连接的权限，再说明缺少哪项授权。

实际绑定已有可用方法时，向请求方提供其可调用的入口。增补原连接的方法时确认实际负责人，交接原连接 ID、方法 ID、修订和可共享的来源。交接前查看 `maintainer.can_repair` 和 `maintainer.run_status`。`run_status.status:"blocked"` 时说明需要恢复的条件。`"configured"` 表示 Bot 已启用且有获准的模型连接，是否接手以实际回执为准。同一专责 Bot 可负责多条相关连接。用当前 `revision` 提交修改。登记返回 `reused:true` 时读回原对象。存在多个候选时，根据真实环境、项目和账号选择。创建专责 Bot 时，用获准的 `create_bot` 和 `role_id:"catalog-maintainer"`、`role_connection_id`、`connection_revision` 一次创建并关联。已有 Bot 用 `assign_maintainer` 或宿主连接设置分配。长期 `instructions` 说明职责和适用范围，实际版本、路径和方法从连接读回。

## 宿主授权

Summon 启动时会复用或创建默认接口 Bot（`tool-onboarding`）。群聊协作按群成员处理。Bot「资源权限」中的工具接入授权对应 `/api/bots/{id}/access` 的 `execution_onboarding`。查询和更新使用 Bot ID 与当前权限 `revision`。可从以下授权开始。

```json
{
  "discover": { "path": true, "directories": [] },
  "executables": [],
  "credential_refs": [],
  "targets": [],
  "submit": false,
  "assign_maintainer": false
}
```

`discover.path` 指执行服务的 PATH，`directories` 指选定目录的直接子项。已登记且可读的路径也可查。`executables` 是允许探测或登记的现有绝对路径。提交配置还需要 `submit` 或该连接的现有修复权限。赋予用途、直参、文件访问和工作目录写权限时用各自的连接或资源设置。负责人和内置职责只确定协作对象。

`targets` 可授权以下实际绑定。HTTP 方法的完整 URL 和请求动词由宿主列出，允许引用的环境变量放在同一目标的 `credential_refs`。使用凭据时指定真实 `account` 区分账号或租户。凭据内容留在宿主配置。SSH 固定命令由宿主授权，stdio MCP 的程序、参数、工作目录和环境映射共同决定可启动的服务。

| 协议 | `targets` 中的授权项 |
| --- | --- |
| HTTP | `{protocol:"http",service_url,account,methods:[{url,method}],credential_refs}` |
| MCP HTTP | `{protocol:"mcp",transport:"http",url,account,credential_refs}` |
| MCP stdio | `{protocol:"mcp",transport:"stdio",command,args,workspace_root,account,env,credential_refs}` |
| SSH | `{protocol:"ssh",executable,ssh:{host,port,user,identity_file,operations:[{id,command}]}}` |

普通 CLI 以宿主上的真实可执行路径、协议、执行目录范围和凭据范围匹配。HTTP 按 `service_url` 与账号区分，MCP 还看传输和 stdio 启动配置。SSH 比较实际远端、端口、账号和密钥选择。登记时用 `initialize_execution {action:"register",protocol,name,config}`。启用的工具及其依赖供全体 Bot 发现和调用。宿主可用 `repair_bot_ids` 指定修复者，在私有 CLI 初始化中也可用 `grant_access` 授予修复权限。

分派后由对应专责 Bot 日常维护。用 `read` 核对连接用法和维修权。宿主设置时可核对 `repair_bot_ids`、初始化授权和覆盖同一目标的 `execution_onboarding.submit`。脚本依赖的解释器连接需支持直接传参。群项目任务从发起群取得执行目录，组内成员可通过同一接入调用工具。

更新原连接的配置时，用 `register` 带上原 `connection` ID、当前 `revision`、`protocol` 和待修改的 `config` 字段。`inspect.version` 是实装版本，`read.version` 是登记版本。确认本机 CLI 的实装版本有变化后，可只提交版本更新。

```json
{
  "action": "register",
  "connection": "原连接 ID",
  "revision": 3,
  "protocol": "cli",
  "config": { "detected_version": "inspect 返回的非空 version 字符串" }
}
```

沿用原连接的程序路径和其他配置。用回执或 `read` 确认保存后的 `version`，下一次登记或更新方法时使用最新 `revision`。

## CLI 探测规则

`inspect` 有登记规则时直接使用，`probe_source` 为 `saved`，首次按通用用法运行时为 `default`。`observations` 逐项给出实际程序、参数、工作目录、退出状态、采用的 stdout/stderr 编码和有限输出。`probe_rule_mismatch` 表示实际退出状态或输出与规则不符。回执中的 `maintenance` 说明当前 Bot 可直接承接、已交接给原负责人、已有待处理任务或缺少的条件。未指定负责人时可由有维修权的接口 Bot 承接。收到 `connection.failure` 的探测事件后，读回连接的最新修订和原方法。

先从实际输出中找到新用法。用 `inspect` 传原 `connection`、当前 `revision` 及 `probe` 试跑候选。版本和帮助各有自己的参数数组。`exit_codes` 默认是 `[0]`。`version.read` 可指定 `stream`（`stdout`、`stderr` 或 `combined`）、`line` 和 `word`，行与词从零开始。缺省时读取合并输出的首行。`help.stream` 选择帮助的来源。

```json
{
  "version": { "args": ["实测版本参数"], "exit_codes": [0], "read": { "stream": "stdout", "line": 0 } },
  "help": { "args": ["实测帮助参数"], "exit_codes": [0] },
  "encoding": { "stdout": "utf8", "stderr": "utf8" }
}
```

根据实际输出选择两个流各自的编码，两项也可设为 `auto`，Windows 自动模式会在 UTF‑8 与当前 OEM 编码之间选择。可加 `diagnostic_args` 用同一绑定和编码试跑附加诊断，例如带有非 ASCII 文本的只读帮助请求。诊断退出状态单独记录。

候选 `inspect` 返回 `probe_source:"candidate"` 和 `status:"observed"` 后，用 `register` 传原 `connection`、同一 `revision`、原 `protocol`、候选回执的 `call_id` 作为 `probe_call`、以及 `config:{probe,detected_version}`。其中 `probe` 使用实跑的候选对象，`detected_version` 使用回执的 `version`。读取最新修订后可用 `upsert_method` 更新升级影响的原方法 ID，并用原连接实际调用。

多步探测可在候选 `probe.script` 使用已有授权的 Node 运行器，指定 `runner:{id,binding_version}` 和 `source`（ES 模块），或指定本连接已获准的 `path:"scripts/文件.mjs"`。使用现有连接的执行目录和工作目录授权。运行器从 stdin 读取一行 `{"summonProbe":{"executable":"...","purpose":"version","args":[]}}`，`purpose` 为 `version` 或 `help`。脚本传回子命令输出或处理后的文本和退出状态，按登记的编码及读取规则解析。用 `source` 操作读取本连接已登记的脚本文本。

[探测脚本示例](examples/probe.mjs) 可用 `initialize_execution {action:"guide",example:"probe"}` 读取。本示例按 `purpose` 选择参数，将子进程的 stdout 与 stderr 字节逐流转交，沿用真实退出状态。下例使用支持 `--version` 和 `--help` 的程序。读取实际原连接和 Node 运行器，分别以 `original` 和 `nodeRunner` 表示其 `read` 结果。用原连接的 `source` 或示例工具返回的 `text` 作为 `probeSource`。

```js
const probe = {
  version: { args: ['--version'], exit_codes: [0], read: { stream: 'stdout', line: 0 } },
  help: { args: ['--help'], exit_codes: [0], stream: 'stdout' },
  encoding: { stdout: 'auto', stderr: 'auto' },
  script: {
    runner: { id: nodeRunner.id, binding_version: nodeRunner.binding_version },
    source: probeSource,
  },
};
const candidate = { action: 'inspect', connection: original.id, revision: original.revision, probe };
// Call initialize_execution with candidate. Inspect the observed outputs and version.
const save = {
  action: 'register', protocol: original.protocol, connection: original.id, revision: original.revision,
  probe_call: observed.call_id,
  config: { probe, detected_version: observed.version },
};
```

候选实跑成功后提交 `save`，再用普通 `inspect` 确认 `probe_source:"saved"`。当业务执行流也采用该编码时，选用确实适用于两类输出的 `probe.encoding`，按原方法实调确认文本。

## 固定方法和服务协议

- CLI 的 `config.file` 是绝对可执行路径，实际路径由执行服务解析。`config.methods` 中每项包含 `id` 和 `args`，可附 `name`、`description`、`effect`、`file_args`、`input`、`keep_input`、`env`。参数模板用 `{{parameter}}`，调用方用 `open_session` 的 `engine`（连接 ID）、已授权的 `workspace` 和 `input:{method,parameters}`。文件角色示例 `file_args:[{index:0,access:"read",kind:"file"}]`，索引从零开始，访问可用 `read`、`write` 或 `read-write`。已有直参授权才可传 `args`。用 `{action:"upsert_method",connection,revision,method}` 更新一个实际方法。
  更新原方法时沿用原 `method.id`。`read` 会返回 `effect` 和 `file_args`，省略这两个字段时沿用原值。若参数位置变化，按新位置调整 `file_args` 索引并保持原访问方式。
- SSH 使用 CLI 的目录授权和 `config.file`，在 `config.ssh` 指定 `host`、`port`（默认 22）、`user`、可选的 `identity_file` 和 `operations`。调用输入为 `{method,parameters}`，固定命令可省略 `parameters`。每项的 `id` 对应已批准的 `command`，模板 `{{parameter}}` 的取值须由宿主在该操作的 `parameters` 逐项列出。用 `read` 查看获准值。宿主提前配好已核对的主机密钥和 SSH 登录权限。
- HTTP 的 `config` 含 `service_url`、适用的 `account` 和 `tools`。每个方法含 `name`、`description`、`url`、`method` 和对象 `inputSchema`。按需使用 `request.path`、`request.query`、`request.body` 映射输入，`headersEnv` 将请求头映射到获准环境变量名。服务返回操作 ID 时，可选 `lifecycle` 将 `operation_id_path`、`status_path`、状态映射 `statuses` 和 `status_method` 等绑定到原操作。已有方法以 `name` 为方法 ID。调用输入为 `{method,arguments}`。
  有维修权时从 `read` 的 `method_bindings` 读取生效映射。对照同一获准服务的当前契约和实际 HTTP 状态，按原方法名用 `upsert_method` 更新所需字段。扩大 URL、动词或凭据范围需要宿主对目标的实际授权。
- MCP 的 `config.transport` 为 `stdio` 或 `http`。stdio 填绝对 `command`、`args`、`workspace_root` 和按授权需要的 `env`（值形如 `{env:"NAME"}`）。HTTP 填 `url` 和适用的 `account`、`headersEnv`。用 `read` 读取协议发现的工具名和参数，再用 `{method,arguments}` 调用。MCP 方法由服务端协议发布。

## 会话型 CLI

Codex 的 `protocol:"codex"` 使用内置 app-server。Grok Build 等内置 CLI 的宿主初始化可用 `register` 的 `connector` 和实测 `executable`，并用 `inspect`、`source` 和 `documentation` 查询适配及上游。使用 `adapter.arguments` 调整内置连接器的 `common`、`start`、`resume` 参数组。保留适配器管理的参数。

CLI 的 `config.adapter` 可用内置 `connector` 和 `settings`，或使用 `recipe`、`source`，并声明 `resume` 布尔值。`recipe.args`（字符串数组）和 `recipe.output`（字符串 `"plain"`、`"json"` 或 `"jsonl"`）必填。`args` 直接传给程序，可用 `{{text}}`、`{{prompt_file}}`；用 `stdin:true` 时，任务文本写入 stdin。`recipe` 不接受 `format` 键，`output` 也不是对象。

以下是 Windows `sort.exe` 的完整 `initialize_execution` 登记请求：stdin 文本、无启动参数、纯文本输出、无需续接。按实际执行主机确认 `config.file` 并使用宿主已授权的路径。

```json
{
  "action": "register",
  "protocol": "cli",
  "name": "Sort text",
  "config": {
    "file": "C:\\Windows\\System32\\sort.exe",
    "adapter": {
      "resume": false,
      "recipe": { "args": [], "stdin": true, "output": "plain" }
    }
  }
}
```

由宿主通过 `POST /api/connections` 提交时，使用 `kind:"cli"`、`name` 和同一个 `config`，并在 `config.canonical_file` 填入已解析的真实可执行路径。若更新已登记的绑定，带上原连接 ID 和当前修订。登记后用 `open_session` 选择该连接和获准的可写目录，输入可用 `{"text":"zebra\r\napple\r\n"}`。

JSON 输出可设 `session_id`、`progress`、`result`、`error` 字段路径。逐行 JSON 需要 `complete_when:{path,equals}`，可用 `success_when` 判断成功。续接需要 `resume:true`、`session_id` 和含 `{{session_id}}` 的 `resume_args`；纯文本配方不支持续接。

脚本使用 Node.js ES 模块。`source` 保存脚本，`runner:{id,binding_version}` 绑定拥有直参授权的既有解释器连接。stdin 收到一行 `{"summonStart":{"executable":"...","text":"...","sessionId":null}}`，实际 cwd 是获准目录。用参数数组启动给定程序，根据真实响应逐行发出 `summonEvent`。

- `{type:"session",sessionId}` 保存已确认的原生会话 ID。恢复时核对 ID。
- `{type:"progress",text,itemId,phase}` 记录可观察的进度。真实工具调用可用 `{type:"tool",itemId,tool,phase,status,command,text}` 提供必要证据。
- `{type:"result",text,confirmed}` 保存观测到的结果。CLI 实际确认时设 `confirmed:true`。
- `{type:"outcome",status,error}` 保存终态，状态含 `completed`、`failed`、`stopped`、`unknown`、`not_submitted`、`unsupported`。

[会话脚本示例](examples/session-adapter.mjs) 可用 `initialize_execution {action:"guide",example:"session"}` 读取。它运行绑定的 Windows `sort.exe`，将 stdin 纯文本送给上游，并回报实际启动、输出和终态。换其他程序时从参数映射、输出编码和结果解析处入手。上游支持续接时，将 `summonStart.sessionId` 放入上游规定的恢复参数，比较响应实际确认的 ID，确认后再发 `session` 及结果。启动失败发 `not_submitted`，进程开始后的超时或无法确认的回复发 `unknown`。

用 `source` 读原连接的脚本、`runner_binding` 及 `resume`。下例将已登记的内联会话脚本更新为修好的 `adapterSource`。首次登记 `sort.exe` 的内联版本时可取示例的 `text`，使用单独已授权的 Node 运行器，并设 `resume` 为 `false`。

```js
const update = {
  action: 'register', protocol: 'cli', connection: original.id, revision: original.revision,
  config: {
    adapter: {
      resume: source.resume ?? false,
      runner: { id: nodeRunner.id, binding_version: nodeRunner.binding_version },
      source: adapterSource,
    },
  },
};
// After updating, read source and make a real call on the same connection.
const input = { engine: original.id, workspace: grantedDirectory, input: { text: 'zebra\r\napple\r\n' } };
```

在已有的解释器和目录授权内用实际输入试跑候选。更新后用 `source` 核对新源码，保留原连接和解释器，调用 `open_session` 并检查真实回执。

委托引擎编写适配时，用 `open_session` 的 `include_execution_guide:true` 将本发行版手册附加到文本任务，或传入相关原文。明确要交付的配置、脚本和接口。通过 Session、实际回执及产物核对交付。对已有原生 Session 续发或审批时，使用 `read` 返回的 `control_version` 与 `input_target`；恢复暂停使用实际 `resume_ref`。按实际结果区分登记、调用资格、提交状态和终态。

## 群里的工具协作

把实际属于群的任务通过 `open_session` 的 `work_room` 提交，已有原消息时一并传 `work_source`。共享给全体房间读者的任务默认记录工具观察。要保持工作记录私有可设 `private_work:true`，或用无需群工作归属的私有 Session。指定读者的共享执行保留其受限范围。群成员能按房间用 `find {kind:"event",scope:{kind:"room",id}}` 找到 `work.tool`，用 `read` 查真实程序、工具步骤、有限输出或失败诊断。执行和调用引用按各自授权读取和操作。总接口 Bot 默认在普通群按 @ 和回复参与。回答时用 `send` 回复原消息，并附同群可读的来源。

## 沿连接转交维修

参数或业务输入导致的错误先在原任务内处理。有实际证据显示固定方法、绑定、探测或会话脚本需要维护时，使用原连接和可共享来源。

```js
const request = {
  to: { kind: 'connection', id: original.id },
  text: '原方法收到上游参数校验失败。请核对当前帮助与原方法参数，实调后回复。',
  references: [{ kind: 'call', id: failedCallId }],
};
const reply = {
  to: { kind: 'connection', id: original.id },
  reply_to: receivedRepairEvent,
  repair_outcome: 'repaired',
  text: '已更新原方法并用原样例实调成功。',
};
```

发起者调用 `send({message: request})`，可以用同一个 `repair_key` 关联已经确认是同一故障的不同调用。专责 Bot 用 `read` 查维修事件及补充来源，然后调用 `send({message: reply})`。收到结果后从原调用的实际状态继续。结果不明时先读原操作。代群友提交时沿原群消息反馈。

## Bot 维护群

每套 Summon 默认有一个 Bot 维护群。需要日报时，为总接口 Bot 在该群设置每日的 `set_wakeup` 时间规则。用 `find {kind:"connection_usage"}` 读上一个完整自然日的获准调用汇总，可按 `scope` 查询房间、连接或 Session。用 `period:"7d"` 看近期变化，或者给出带时区的 `{from,to}`。每个实际调用按调用 ID 计一次，按连接、方法、登记版本和实际状态汇总。缺历史方法或版本时相应字段为空。进度与重复投递沿原调用归并。群里有具体讨论议题时 @ 相关负责人，确认后的跨接口经验用已有共享资料保存。
