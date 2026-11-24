[English](WEB_AUTH.md) | [简体中文](WEB_AUTH.zh-CN.md)

# 网页与 App 访问认证

Summon Bot 的用户访问控制由 `web/backend/auth.mjs` 在全部 HTTP 路由之前统一执行，覆盖 API、SSE 流、附件下载、客户端发行接口、静态资源与旧 Service Worker 清理脚本；本机回环访问同样需要有效凭据，不设豁免。

## 1. 访问令牌（`web.accessToken`）

- 正式部署在数据根 `config/deployment.json` 的 `web.accessToken` 中保存独立的 32 字节随机令牌（base64url 编码，至少 43 字符）。
- 该令牌独立于内部网关通信凭据，绝不写入源码仓库。
- 新部署自动生成；若配置缺失或长度不足，Web 进程直接拒绝启动。

## 2. 各端认证方式

- **iOS / Android 原生客户端**：用户在连接设置中输入访问令牌（iOS 存系统 Keychain，Android 存加密存储），请求时通过 `Authorization: Bearer <token>` 认证。
- **网页与 Electron 桌面端**：
  - 首次未登录访问根路径或页面时，仅返回状态码 `401` 的独立最小登录页（不泄露任何业务数据，启用严格 `Content-Security-Policy` 随机 nonce、`Referrer-Policy: no-referrer` 与 `frame-ancestors 'none'`）。
  - 提交令牌调用 `POST /auth/session`（以 Bearer 头携带，令牌不放入 URL 或 `localStorage`）校验通过后，服务端签发 HMAC-SHA256 签名会话 Cookie：
    - 公网 HTTPS 使用 `__Host-summon_session` 并启用 `Secure`；
    - 本机 HTTP（如 `8787`）使用端口隔离的 `summon_local_session`（非 8787 端口附加 `_<port>`）。
  - Cookie 统一携带 `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`（30 天有效），活跃使用时按天自动滑动续期；页面刷新、重启浏览器或重启后端服务均不会失效。
  - 由于签名绑定当前 `web.accessToken`，一旦修改正式配置中的令牌并重启 Web，原令牌与所有已签发网页会话立即失效；网页收到 API `401` 后自动回到登录页。

## 3. 失败限流与本机发行回退

- 缺失或无效凭据按底层 TCP 连接源地址（`req.socket.remoteAddress`，不信任伪造的转发头）统计：单来源每分钟最多 **20 次**，全服务每分钟最多 **200 次**（来源跟踪表上限 4096 条），超限返回 `429` 与 `Retry-After: 60`。
- 通过反向隧道访问时，公网访客可能共享同一本地来源额度；但已持有效令牌或有效签名 Cookie 的合法请求不受失败计数影响，防止攻击者锁死正常用户。
- 签名会话无状态校验，不占用服务端会话表内存。此限流专用于认证失败节流，不替代公网边界流量防护。
- 未认证的本机匿名客户端发行请求同样会被拒绝，客户端将按既定规则自动回退至公开 GitHub Releases 查询与下载。
