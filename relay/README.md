# Summon Relay Hub

轻量级多电脑互联中枢服务：提供邀请码账号管理、PC 节点出站 WSS 多路复用隧道、聚合 SSE 事件流、静态网页托管与统一 APNs 推送代理。

中枢**不存储**任何群聊消息、附件或模型 API Key，仅保留账号、邀请码、节点注册表和推送设备令牌。

## 快速自部署（Docker Compose）

在仓库根目录或 `relay/` 目录执行：

```bash
cd relay
docker compose up -d --build
docker logs summon-relay
```

首次启动且数据库为空时，日志会打印一个初始管理员邀请码（`SUMMON-ADMIN-...`）。

将反向代理（Caddy / Nginx）指向 `127.0.0.1:8790` 并启用 HTTPS（需透传 WebSocket 与 SSE）。

Caddy 示例：

```caddy
summon.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

## 常用运维命令

```bash
# 生成普通试用邀请码（可用 5 次，7 天有效）
docker exec summon-relay node /app/relay/src/cli.mjs invite create --uses 5 --days 7 --note "试用朋友"

# 查看邀请码
docker exec summon-relay node /app/relay/src/cli.mjs invite list

# 吊销邀请码
docker exec summon-relay node /app/relay/src/cli.mjs invite revoke SUMMON-XXXX-XXXX-XXXX

# 查看用户 / 停用 / 重置密码
docker exec summon-relay node /app/relay/src/cli.mjs users list
docker exec summon-relay node /app/relay/src/cli.mjs users disable <userId>
docker exec summon-relay node /app/relay/src/cli.mjs users reset-password <userId> <newPassword>
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUMMON_RELAY_PORT` | `8790` | 监听端口 |
| `SUMMON_RELAY_DATA_DIR` | `/data` | SQLite 与可选 `config/apns.json` + `config/apns.p8` 目录 |
| `SUMMON_RELAY_MAX_UPLOAD_MB` | `20` | 中枢允许转发的单附件大小上限（MB） |
| `SUMMON_RELAY_MAX_CONCURRENT_LARGE` | `2` | 单账号同时允许在途的大文件传输并发数 |
| `SUMMON_RELAY_BOOTSTRAP_INVITE` | 自动生成 | 空库首次启动时预设的初始管理员邀请码 |
