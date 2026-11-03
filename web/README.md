# Summon Bot Web

Web 只负责用户 HTTP 入口、普通网页与客户端发行包分发。`startWeb({ gatewayUrl, gatewayToken, ... })`
把受支持的 `/api/` 请求转发给能力服务；它不加载 Pi、不创建 Bot、不打开业务数据库。

关闭 Web 不关闭能力服务或 Bot。内部 `/tools`、`/mcp` 和管理控制接口不通过公开网页入口转发。
网页写入保持同源检查，上传与普通 JSON 请求分别限制大小；SSE 和产物下载保持流式传输。

`/api/releases` 查询实际已发布的客户端；同前缀下的平台路由提供版本元数据和发行包下载。写入发布接口使用独立私有发布凭据，客户端只查询和下载。旧 `/sw.js` 仅让已有离线组件退出，不再注册 PWA。操作见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。
