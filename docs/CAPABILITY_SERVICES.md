# 独立能力服务与协商热更新

本文描述能力服务重构的实现边界。验证结果记录在 `VERIFICATION.md`，不能用本设计代替运行验收。

## 运行组成

每个 Bot 仍是一个独立 Pi Agent 进程。Web 负责界面，能力网关负责身份、授权、服务目录、版本路由和切换协调。Bot 管理、聊天室、知识库、记忆管理、Codex 执行器、文件工具分别运行在独立服务进程中，每个服务提供 HTTP API、MCP 和受网关凭据保护的内部 RPC。

能力实现位于 `capabilities/<domain>/`；服务运行层位于 `capabilities/services/`。`builtin.mjs` 只为指定领域实例化执行器。网关不执行领域写入或后台工作；目前同机部署下，它读取兼容 SQLite 投影，汇总已有 Web API 的状态。领域之间仍有兼容的管理数据读取，因此本版本不宣称可以把所有领域数据库直接迁移到不同机器。新增独立服务可以通过 HTTPS 注册到网关。

进程和模块不是 Bot。服务没有模型循环，Bot 通过已授权工具使用服务。复制、回收和记忆合并继续由外部管理服务执行。

## 发布与切换

1. 服务的新版本启动在独立地址，完成 manifest、工具名称和数据格式校验。注册不会自动授予 Bot 权限。
2. 激活版本仅改变新绑定的默认值。现有 Bot 的绑定保存在注册表中，不随默认值变化。
3. 网关向现有 Bot 发送 `POST /capability-updates/prepare`。Bot 记录通知、预加载并校验候选工具集；正在执行的模型循环和工具调用继续用旧快照。
4. 当前任务结束后，Bot 暂停后续任务的执行，报告 `ready`。新消息仍可持久接收、排队。
5. 网关持久提交绑定，Bot 持久写入完整工具集和绑定版本后报告 `committed`，再释放队列。工具 URL 明确包含服务版本，防止重启窗口中旧 schema 被发往新实现。
6. 旧服务继续完成其在途请求和后台任务。只有旧绑定、待确认切换、在途请求、未知结果和后台任务全部清零，才允许退役旧版本。

这里“准备好”指 Bot 运行时到达完整任务边界，不依靠模型口头说“可以”。不会在一个模型循环的中间替换工具。旧任务过长时会延后切换；不自动强杀。失败准备保留旧工具，记录原因并允许重试。

卸载同样经过这个协议：先停止产生新绑定，再让已有 Bot 在安全边界移除工具。卸载不等于立即删代码、删数据或杀进程。

## 数据与后台任务

```text
data/
  bots/<bot-id>/             # 独立 Bot 配置、SQLite、记忆、任务和产物
  capabilities/
    registry/state.sqlite  # 注册、授权、版本绑定、请求结果与切换阶段
    <domain>/state.sqlite  # 领域数据；兼容格式允许多个版本读取
    service-runtime/<id>/<version>/
      service.json         # 私密配置、凭据、模块摘要
      run/                 # 内核所有权、PID、启动身份
      logs/                # 有上限的进程日志
    packages/<id>/<version>/ # 自包含服务包的不可变快照
```

聊天室投递和 Codex 工作都保存 `serviceVersion`。新版只接管自己的队列；启动新版不会把旧版正在执行的任务误判为“重启中断”。取消在途工作路由到其所有者，已经结束的工作可以显式在新版继续。目录级跨进程锁协调同一领域的写入；项目工作区锁继续协调文件命令和 Codex 执行。

数据格式使用 `stateVersion`。不同格式不能直接热切换，必须另做兼容迁移。网络断线或网关崩溃不能证明远端副作用完成，注册表保留未知结果，不自动重放，也不把它算成已排空。

## 外部接口

网关 controller API：`GET /api/capabilities`，以及 `POST /api/capabilities/register`、`deploy`、`activate`、`unload`、`grant`、`retry`、`retire`、`reconcile`。Bot 使用同名 `capabilities_*` 工具，仍受角色工具白名单限制。默认工程伙伴和管理伙伴可以发布能力；默认只有管理伙伴获得授权管理和未知结果核对工具。controller 可以显式改变这些授权，不以角色名称替代权限检查。

未知调用通过 `reconcile` 提交 `requestId`、实际核实的 `outcome`（completed 或 failed）和非空 `evidence`；记录核对者及证据，不重新执行原动作。没有证据时保持阻塞。外部注册的非受管服务退役只撤下路由，不宣称关闭外部进程。

服务协议：

- `GET /manifest` 返回 `{id,version,stateVersion,tools}`。
- `POST /tools/<name>` 接受 `{arguments,context}`。
- `POST /mcp` 提供 initialize、tools/list、tools/call。
- `GET /health` 返回在途请求及后台工作数量。
- 服务内部 RPC、排空和关闭使用独立私密凭据，不暴露给普通 Bot。

注册同一版本不能改变工具定义和实现；服务重启后的地址更新必须重新核对 manifest。运行代码应来自经过完整性校验的发行物或服务包快照，不能原地覆盖正在运行的文件。

## 使用方式

```powershell
npm run relay:capabilities -- list --data-root D:/Relay-Bot-data
npm run relay:capabilities -- deploy --file capability-deployment.json --data-root D:/Relay-Bot-data
npm run relay:capabilities -- activate --id knowledge --version v2 --data-root D:/Relay-Bot-data
npm run relay:capabilities -- retire --id knowledge --version v1 --data-root D:/Relay-Bot-data
```

内置能力的部署文件示例：

```json
{"id":"knowledge","version":"v2","releaseRoot":"D:/Relay-Bot-app/releases/<verified-build>","activate":true}
```

只启动新发行物里的指定能力，Web、网关与 Bot 不随之重启。`activate:false` 可以先注册待发布版本。

自定义服务用 `packageRoot` 替代 `releaseRoot`。包根目录放 `capability.json`：

```json
{"id":"example","version":"v1","stateVersion":"1","entry":"index.mjs"}
```

`index.mjs` 导出 `createCapability(options)`，返回 `{tools,callTool,pendingWork,close}`。依赖必须包含在包中；不能让版本实现依赖包外可变源码。发布器复制并校验完整包，拒绝链接、凭据和运行数据。服务属于可信主机代码，模块快照和工具授权不等于操作系统沙箱。

首次从单进程能力网关升级到本结构需要安装新基础运行层。之后的能力版本发布走上述协议。替换 Bot 引擎、网关协议或 Web 本身仍属于基础程序升级，不由能力热更新冒充完成。
