# 网页与 App 访问认证

正式部署在数据根 `config/deployment.json` 的 `web.accessToken` 配置独立的 32 字节随机 Token（base64url，43 字符），不复用内部 gatewayToken/controlToken，不写入源码。未配置时 Web 拒绝启动；新部署自动生成。

iOS、Android 在连接设置中填写该 Token，通过 `Authorization: Bearer …` 访问。网页和 Electron 首次打开只显示登录页；登录后使用 HttpOnly、SameSite=Strict 会话 Cookie，公网 HTTPS 使用 Secure 和 __Host- 前缀。会话有效期 7 天，服务重启后失效。Token 不放 URL 或 localStorage。

认证在全部路由之前执行，包括 API、SSE、附件、发行下载、静态资源和 Service Worker 清理脚本；本机访问也不豁免。唯一无凭据可见内容是返回 401 的登录页，不包含业务数据。网页收到 API 401 后返回登录。

无效/缺失凭据按连接来源每分钟最多 20 次、全服务每分钟最多 200 次，超过返回 429 和 Retry-After。来源取 socket 地址，不信任客户端伪造的转发头；隧道来访可能共享同一来源额度。有效 Token / 会话不受失败额度影响，避免攻击者锁死合法访问。失败记录和会话数量有上限。此限制用于认证失败节流，不替代公网入口的流量防护。

修改正式配置中的 Token 后重启 Web 即撤销原 Token 和全部网页会话。客户端本机匿名发行下载会被拒绝，沿用现有 GitHub Releases 回退。
