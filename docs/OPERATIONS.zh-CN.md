[English](OPERATIONS.md) | [简体中文](OPERATIONS.zh-CN.md)

# 运行维护

Summon Bot 仅运行唯一正式环境：业务数据根目录为 `D:/Relay-Bot-data`，后端程序安装目录为 `D:/Relay-Bot-app`。公网入口 `https://bot.lin0.org` 与本机入口 `http://127.0.0.1:8787` 共用同一实例与数据。

## 1. 启停、状态与日志

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
npm run summon:status -- --data-root D:/Relay-Bot-data
```

- Windows 启动入口使用选定发行物自带的 Node 运行时；双击 `Start-Hidden.vbs` 或 `Run.cmd` 可隐藏终端窗口启动。
- 计划任务 StartupHub `Summon Bot` 通过同一入口运行看门狗，依据服务身份自动恢复意外退出的 Web 与网关进程。正常停止会记录运行意图；用户主动暂停的 Bot、对话与执行会话在重启后继续维持暂停状态。
- 网关与 Web 就绪后本机入口立即可用，Web 在后台恢复已登记的自管远程连接器（Tailscale / Cloudflare Tunnel），恢复结果体现在 `summon:status` 中；远程连接不可用时不影响本机正常使用。
- 配置文件说明：
  - `config/deployment.json`（Schema v4，数据格式 3）：记录当前选定的发行目录、监听地址、访问令牌（`web.accessToken`）、初始模型配置、日志轮转与宿主资源上限。
  - `config/model-connections.json`、`config/model-credentials.json` 与 `config/runtime.env`：管理模型连接、用途模型表、API Key 与凭据引用。日常模型、执行连接与工作区配置均可在网页设置中完成。
- 主要日志位于 `web/logs/`、`web/watchdog/` 与 `capabilities/gateway/logs/`。可在 `config/deployment.json` 中设置 `logs.maxFileBytes`、`logs.maxFiles`、`logs.retentionDays` 与 `logs.sweepIntervalMs`（或按 Web / 网关分别覆写）。托管日志写入失败时服务继续运行，并在 `summon:status` 中报告日志错误。

## 2. 发行与升级

定稿、同步原生端、运行 `npm run release:version` 并提交推送后，执行 `npm run release:all` 即可完成正式网页/后端与 Windows 本机包更新（或单独运行 `npm run release:web -- --committed-only`）。详见 [客户端发行与更新](CLIENT_RELEASES.zh-CN.md)。

### Windows Node 运行时要求

Windows 构建必须使用已修复 TCP keepalive 栈越界问题（`nodejs/node#62561`）的 Node 24 LTS 版本（`build.mjs` 会主动拒绝 `24.15.0` 与 `25.8.0`）。建议使用 24.21.0 / 24.22.1 或更新的 LTS 版本；若系统默认 Node 不符合要求，可将环境变量 `SUMMON_RELEASE_NODE` 指向可用的独立 Node 可执行文件，或直接用该可执行文件运行 `scripts/release/cli.mjs`。

### 有序排空与安装状态机

- 安装进度持久化在 `config/installation_state.json`，严格按 6 阶段独占推进：`prepared` → `draining` → `converting` → `data_ready` → `runtime_ready` → `done`。
- 升级窗口内，安装器先确认现行实例支持有序排空（若涉及协议升级则同时核对同提交客户端发行物已就绪），再关闭自主收件、等待在途调用及其写入落盘，默认排空超时 3 分钟（可用 `--drain-timeout-ms` 调整）。
- 若排空超时或按 Ctrl+C 中断等待，直接重跑同一发行命令即可续接暂存构建；等待输出与 `summon:status` 会列出阻塞排空的调用或服务。若在此期间修复了候选源码，可附加 `--replace-pending` 替换暂存候选。
- 新版本启动就绪后，安装器自动清理被替代的程序目录与构建中转目录；若存在残留清理项，结果中的 `cleanupPending` 会给出具体原因，重跑发行命令即可收尾。`D:/Relay-Bot-data/client-releases` 由客户端发布入口独立维护，不会被后端清理。

## 3. 数据存储与清理历史

- **共享记录库**：`capabilities/chatroom/state.sqlite` 保存房间、成员、消息、附件引用、执行会话与平台对象。
- **Bot 独立状态**：`bots/<bot-id>/state.sqlite` 保存各 Bot 的收件箱、内部对话、调用回执与处理游标。
- **模型账本**：`usage.sqlite` 记录全部真实模型请求与按用途分类的 Token 消耗。
- **清空对话历史**：仅在用户明确要求时，先正常停止正式服务，再执行：

```powershell
npm run summon:history -- --data-root D:/Relay-Bot-data
```

该命令在排他写入锁下清空历史消息并推进 `historyEpoch`，同时保留 Bot 成员、用户资料、文件与 Token 账本。服务恢复后，各端依据新的 `historyEpoch` 自动清理旧本地聊天缓存并保留未发送草稿。
