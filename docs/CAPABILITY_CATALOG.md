# 能力目录与共享 Skill

正式网页“设置与应用 → 能力目录”使用现有能力网关和注册数据库。目录收录本机 CLI、MCP、普通 HTTP API 和共享 Skill。登记工具时创建或复用其专属维护 Bot，维护者处理该工具的版本、方法和故障。其他 Bot 按目录条目的使用范围和当前工作的授权调用。

## 本机 CLI

聊天模型连接后，新手引导让 Pi 在部署主机发起工具发现。`catalog_native_discover` 读取 PATH、安装位置和当前项目入口。Pi 用 `catalog_native_enroll` 登记适用的候选，并复用已有条目和维护 Bot。用户后续介绍工具时也可用这两个入口接入。发现记录保留主机、实际入口和来源，准备状态根据真实观察和已登记的方法更新。

维护 Bot 用 `catalog_native_probe` 读取版本或帮助，用 `catalog_native_method_write` 保存带来源和适用版本的方法。CLI 方法可以保存参数、输入或 Node 脚本。脚本可用 `summon-jsonl` 把会话、进度及输入请求关联到原操作。HTTP API 和 MCP 先按连接方式登记、探测，再将已发现的接口绑定到方法。

Pi 在原 WORK 中使用 `catalog_native_run`，在获准的项目目录运行当前方法并记录稳定的 `operationId`。用 `catalog_native_status` 按游标查询 stdout、stderr 或事件，使用 `catalog_native_input` 和 `catalog_native_stop` 对应原操作。工具提供实际会话标识时，可按已确认的原生会话续接。结果未知时由维护者查询实际效果或原会话，再用 `catalog_native_reconcile` 记录结论。

`catalog_search` 可查随正式版本发布的只读参考文件。搜索 `sRGB ICC profile` 可找到 `reference:srgb-icc`。将目录返回的 `nativeArgument.value` 填入已登记 CLI 方法的只读文件参数。启动时网关解析当前安装中的实际文件。工作中的素材和输出继续按各自的文件授权处理。该 ICC 配置采用 CC0 1.0，原许可随文件发布。 [Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles/blob/abb1b6f48570b4eb0fabd8566e517dca07e617d4/profiles/sRGB-v2-magic.icc)

## 连接

添加连接时填写名称、用途、使用范围、依赖和实际资源引用。专属维护 Bot 的绑定由系统管理，修改条目不会另建负责人；停用条目会停止维护 Bot，移除条目会将它归档并保留有效聊天、工作和知识。维护 Bot 收到咨询或维护提案时按需启动，保存本身不会自动调用业务接口。引用可表示某个连接、账号或对象，不要求预置项目分类。凭据仅引用正式 `config/runtime.env` 的环境变量；不要在配置 JSON、聊天或 Skill 正文填写密钥。

MCP 使用官方 SDK 的 stdio 或 Streamable HTTP，完成 initialize、分页工具发现和 callTool。配置例子：

```json
{
  "transport": "http",
  "url": "https://example.com/mcp",
  "headersEnv": { "Authorization": "SERVICE_AUTH" },
  "toolEffects": { "lookup": "read", "update": "write" }
}
```

`headersEnv` 的值是环境变量名，变量内容是完整请求头值。stdio 使用 `command`、`args` 和 `env: {"NAME":{"env":"SAVED_NAME"}}`；不会把 Bot 的全部环境传入子进程。

HTTP API 可包含多个工具，直接使用 GET、POST、PUT、PATCH、DELETE 等方法，不必包装成 MCP：

```json
{
  "tools": [{
    "name": "update_item",
    "description": "修改指定对象",
    "method": "PATCH",
    "url": "https://example.com/items/{id}",
    "headersEnv": { "Authorization": "SERVICE_AUTH" },
    "effect": "write",
    "inputSchema": {
      "type": "object",
      "properties": { "id": {"type":"string"}, "payload": {"type":"object"} },
      "required": ["id", "payload"]
    },
    "request": { "body": "payload" }
  }],
  "coordination": { "scope": "account:example", "argument": "id" }
}
```

路径占位符默认读取同名参数；`request.path/query/body` 可将输出字段映射到点分输入路径。GET/HEAD 默认把剩余参数放入 query。普通写接口用 `bodyMode: "raw"` 或 `request.body`；现有内部网关继续使用默认 `{arguments: ...}`。

`coordination` 按实际账号/资源与对象 ID 协调并发：相同对象串行，不同对象可并行。没有配置协调键时不推断业务对象。写操作使用稳定 `operationId`；断连、超时或回执写入不明保留 unknown，不自动重试。先查原调用或外部状态，确认实际结果后再继续。MCP 返回 `isError`、HTTP 非成功状态都保留失败。

## Skill

可填写正文，或导入含 `SKILL.md` 的文件夹及 `scripts/`、`references/`、`assets/` 中的文本资源。正文只保存于数据根 `capabilities/skills/<id>/SKILL.md`，目录索引保存修订、范围、依赖与责任关系，不保存第二份永久正文。

维护者读取当前修订后更新同一份文件；并发旧修订写入会失败，需重新读取再合并。其它 Bot 的具体观察和纠正成为发给维护者的提案。提案使用独立维护工作，完成后更新维护记录，不重新唤醒已完成的业务工作。共享 Skill 不复制进每个 Bot。既有 Bot 私有方法仍保留原范围。关闭连接后，依赖它的 Skill 同步显示不可用。

工作中的原始工具结果与用户纠正进入已有 S1/S2/S3 流程。新的短暂整理对话判断复用价值，优先修正现有方法；没有可靠增量时不创建 Skill。正文记录适用条件、已观察步骤、失败处理和来源，不用实时业务事实或秘密代替执行记录。确定步骤可以使用附属脚本或已登记的 API 映射；读取脚本不等于执行授权。

永久整理与压缩只读取当前范围及直接来源；临时上下文组装可以发现其它相关范围。新工作按当前请求、实际连接/对象引用和目录描述选择相关资料，正文按需读取。同一 work 串行、不同 work 隔离；前台组装/压缩有独立的一个执行位置，后台整理仍按 `maintenanceConcurrency` 限制。此调度不代表大规模吞吐承诺。

## Bot 与接口

普通 Bot 的角色模板和正式安装配置包含 `catalog_search/get/probe/register/update/call/reconcile/delegate/skill_write/skill_propose`。每个目录项仍单独检查使用范围和负责人。简单工具可直接调用，需业务判断时才委托负责 Bot，结果通过现有工作/会话路由返回。

Web 使用 `/api/catalog` 的增删改查、`/:id/probe`、`/:id/resource` 等接口。Bot 使用已有独立能力令牌调用 `/tools/catalog_*`。HTTP 探测仅检查配置与可加载性，不冒充一次真实业务请求；MCP 探测验证传输握手和工具发现。调用记录保持实际成功、失败或未知状态。

## 展示来源

维护 Bot 用 `catalog_native_source_register` 在实际工具资源上登记展示来源、账号引用与可执行动作，再用 `catalog_native_publish` 发布带原始观察引用、修订和观测时间的结果。指标支持额度、金额、数值、状态、进度、文本、表格和文件引用。额度窗口保留单位、范围、方向与重置时间。旧修订结果留在历史中，当前快照按对应资源和来源的修订更新。

客户端通过 `/api/model-settings/usage` 读取来源，`/api/works/:id` 根据实际工具绑定返回相关来源。已登记的非交互只读方法可直接刷新，其他动作交给维护 Bot。并发刷新复用同一请求，失败时保留对应状态与已有快照。

完整更新继续使用 `docs/OPERATIONS.md` 中唯一正式安装流程；有效聊天、Bot、工作、记忆和用户文件原地保留。
