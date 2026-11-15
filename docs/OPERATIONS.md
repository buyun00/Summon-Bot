# 运行维护

正式数据根为 `D:/Relay-Bot-data`，后端安装在 `D:/Relay-Bot-app`。公网和本机入口共用这份数据，分别为 `https://bot.lin0.org` 和 `http://127.0.0.1:8787`。

## 启停与配置

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
npm run summon:status -- --data-root D:/Relay-Bot-data
```

Windows 启动入口使用选定发行物中的 Node。双击 `Start-Hidden.vbs` 或 `Run.cmd` 可隐藏终端启动。现有 StartupHub `Summon Bot` 任务通过同一入口运行看门狗，依据服务身份恢复已退出的 Web 和网关。计划任务与手动入口均读取安装状态。正常停止会保存运行意图，用户暂停的 Bot、对话和执行会话继续遵守各自控制记录。

网关与 Web 就绪后，本机入口可用。Web 在后台恢复已登记的自管远程连接器，`summon:status` 的 Web 状态会显示恢复结果。远程配置无法读取时，本机仍可用。远程条目按各自地址登记和验证。

`config/deployment.json` 保存选定发行目录、正式监听地址、模型初始配置及宿主资源设置。外部模型和已有凭据由 `config/model-connections.json`、`config/model-credentials.json` 及该连接引用的凭据来源管理。由网页设置修改模型、执行连接、资源上限和实际执行目录权限。

主要日志位于 `web/logs/`、`web/watchdog/` 和 `capabilities/gateway/logs/`。需要调整轮转时，可在部署配置中设置 `logs.maxFileBytes`、`logs.maxFiles`、`logs.retentionDays` 与 `logs.sweepIntervalMs`，或使用 Web 和网关各自的 `logs` 覆盖。

托管日志无法写入时，服务继续运行，`summon:status` 显示相关日志错误。看门狗由原计划任务托管。

## 发行与升级

定稿、同步原生端、递增版本并提交推送后，可执行 `npm run release:all` 更新正式 Web 与 Windows 本机包。同协议时可先更新 Web。协议变更时，Windows 本机包与各远程渠道的同提交版本先就位。具体命令见 [客户端发行与更新](CLIENT_RELEASES.md)。

应使用修复 Windows TCP keepalive 问题的 Node 24 LTS 版本完成构建。正式旧包携带 24.21.0，可用独立安装的 24.22.1 运行新构建和安装器。系统 Node 是 24.15.0 时，可将 `SUMMON_RELEASE_NODE` 指向可用的独立 Node，或直接用该可执行文件运行 `scripts/release/cli.mjs`。

```powershell
npm run release:web -- --committed-only
```

安装器先确认当前运行支持有序收尾，并在协议变更时确认对应客户端发行已就绪。更新窗口内，正在运行的调用及对应写入完成后关闭接收，等待服务退出。安装器随后在同一数据根准备部署配置，再选择并启动新版本。

`config/installation_state.json` 保存安装进度。排空等待默认三分钟，可用 `--drain-timeout-ms` 调整。若排空超时或用 Ctrl+C 停止等待，重跑同一发行命令即可续接暂存构建。等待输出和 `summon:status` 会显示相关调用或服务的进度。修复了候选源码时，可运行 `npm run release:web -- --committed-only --replace-pending` 更换安装候选。数据转换和服务选取由安装器独占执行。

新服务启动后清理被替代的程序和构建产物。若清理尚未完成，部署结果中的 `cleanupPending` 给出错误，可重跑发行入口继续收尾。Windows 本机发行目录由客户端发布入口管理。

0.3.100 的一次性格式转换已完成。原聊天、文件、暂停、调用及接收状态由当前格式保留。

## 数据与运行

房间、成员、消息和平台对象使用 `capabilities/chatroom/state.sqlite`。Bot 内部的接收、处理、调用和等待位置由其数据目录下的 SQLite 保存。模型账本位于 `usage.sqlite`。达到上限时保留已有输入，按设置的额度和用户控制恢复允许的处理。

用户明确要求清空对话历史时，正常停止正式运行，再按实际数据根执行 `npm run summon:history -- --data-root D:/Relay-Bot-data`。清理持有排他写入锁，保留成员、用户资料、文件及用量。恢复后客户端依据数据根的 `historyEpoch` 清除旧聊天缓存并保留未发送草稿。
