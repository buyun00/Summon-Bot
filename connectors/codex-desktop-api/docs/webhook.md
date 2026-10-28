# 出站 Webhook

API 进程订阅 Broker 的 `event`，与 SSE 使用同一桌面 IPC 事件源；无需 SSE 客户端或 Codex skill。默认关闭。修改 `config.local.json` 后重启 `Stop.ps1`、`Start.ps1`。

```json
{
  "webhook": {
    "enabled": false,
    "url": "https://your-receiver.example/events",
    "secret": "replace-with-a-random-shared-secret",
    "events": ["thread.status:idle", "thread.status:completed", "thread.status:failed", "waiting_for_input", "desktop.disconnected"],
    "debounceMs": 300,
    "minIntervalMs": 1000,
    "timeoutMs": 5000,
    "maxAttempts": 3,
    "retryDelayMs": 1000,
    "maxQueue": 256
  }
}
```

把该对象合并到已有配置，保留其他字段。启用时 URL 和非空 secret 必填。HTTP/HTTPS 均可，不跟随重定向。secret 仅用于出站签名，不是 API 登录凭据。

## 事件与范围

- `thread.status:idle`、`thread.status:completed`、`thread.status:failed`：对应状态变化。当前 turn 已 completed/failed 时，摘要 status 优先使用 turn 的终态（即 runtime idle + turn completed 发送 completed）。
- `waiting_for_input`（别名 `thread.status:waiting_for_input`）：桌面等待输入/批准。
- `thread.status`：上述四种状态全部启用，不转发运行中输出。
- `desktop.disconnected`：桌面 IPC 连接断开，status 为 unavailable，threadId 等字段为 null。

首次快照只建立基线，不为已有历史终态补发通知；首次快照等待输入时会通知。后续快照变化也能通知。按 host/thread、status、turnId 去重；相同线程在 debounceMs 窗口内只保留最新通知，窗口不会无限延后。所有发送尝试之间至少间隔 minIntervalMs。不同 host 的相同 threadId 分开处理。

覆盖范围继承现有 Broker：自动发现近期（discoveryLimit）及置顶的活动 Codex 聊天，并订阅其 IPC；也涵盖 API 已订阅的聊天。不是所有历史聊天的全量监控，发现间隔内已开始并结束的任务可能漏报。远程主机需桌面本身能够提供对应事件。

## 请求与重试

POST JSON 包含 `id`（通知 UUID）、`eventId`（本地 SSE journal ID）、`eventType`、`threadId`、`hostId`、`title`、`cwd`、`status`、`turnId`、`at`（源事件 ISO 时间）。不包含聊天正文。`X-Webhook-Id` 等于 id；`X-Webhook-Signature` 为 `sha256=` 加 secret 对**原始 UTF-8 请求体**计算的 HMAC-SHA256 十六进制值。

2xx 成功；网络错误、超时、408、429、5xx 最多尝试 maxAttempts 次（含首次），退避 retryDelayMs × 2^(重试序号-1)。其他 HTTP 状态不重试。同一通知重试使用相同 ID、body 和签名；接收端必须持久化 ID 去重，再触发 bot，避免超时后重复执行。可检查签名覆盖的 at 来限制重放时效。

独立异步有界队列不等待主 API；队列满丢弃新线程通知并记录 queue_full。进程退出/重启会丢弃未完成通知，不提供持久投递或恰好一次保证。日志位于 dataDir/webhook.log，记录事件 ID、尝试次数、HTTP 状态或错误类别，不记录 URL、secret 或摘要内容；约 1 MiB 轮转到 webhook.log.1。不新增配置管理接口，不通过 API 回传 secret。

## 验证

1. 在 webhook.site 创建独立接收 URL，填入 url、随机 secret 并设置 enabled=true，重启 API。此服务会收到摘要中的标题和 cwd，测试时使用专用测试聊天。
2. 让测试聊天运行后完成，或进入需要输入的状态；检查收到的 POST、上述字段及签名头。无需打开 SSE。
3. 自建接收端可运行 `node examples/webhook-receiver.mjs`，先设置环境变量 WEBHOOK_SECRET，与配置一致；url 使用 `http://127.0.0.1:47832/events`。示例验证原始 body 签名并按 ID 做内存去重，生产接收端应改为持久化去重。
4. 关闭接收端后产生新事件，检查 webhook.log 中有限次数失败；enabled=false 重启后不再发送。
5. `npm test` 包含模拟桌面 IPC + 实际 loopback HTTP 收包测试；`npm run doctor`、`npm run smoke` 是真实桌面只读检查，不能替代真实任务完成通知验收。
