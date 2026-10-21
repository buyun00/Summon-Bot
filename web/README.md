# Relay Web

Web 只负责用户 HTTP 入口、静态页面与 PWA。`startWeb({ gatewayUrl, gatewayToken, ... })`
把受支持的 `/api/` 请求转发给能力服务；它不加载 Pi、不创建 Bot、不打开业务数据库。

关闭 Web 不关闭能力服务或 Bot。内部 `/tools`、`/mcp` 和管理控制接口不通过公开网页入口转发。
网页写入保持同源检查，上传与普通 JSON 请求分别限制大小；SSE 和产物下载保持流式传输。
