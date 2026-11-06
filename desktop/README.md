# Summon Bot 桌面端

Windows x64 和 Apple Silicon macOS 的桌面安装包内置 Electron、Node、Web、服务端和 Codex 桌面连接器。首次打开时可创建本机工作区，或填写已有工作区的地址和访问令牌。Electron 显示所选实例的网页。

本机模式使用 `http://127.0.0.1:8787`，数据默认保存在用户应用设置目录下的 `Relay/workspace-data`，初次创建时可指定绝对路径。关闭窗口后服务继续运行，菜单可明确停止。可以选择已运行的外部工作区数据目录，原安装入口负责该实例的启停和升级。

## 安装后的命令

Windows 入口为安装目录的 `summon.cmd`。macOS 入口为 `Summon Bot.app/Contents/Resources/summon`。下例以 `summon` 表示对应命令。

```text
summon status
summon local [--data-root PATH]
summon start
summon stop
summon remote --address HTTPS --token-file PATH [--stop-local]
summon access status tailscale
summon access prepare tailscale --port 443
summon access apply tailscale --plan PLAN_ID --confirm
summon access revoke tailscale --confirm
summon access prepare cloudflare --origin HTTPS --owner external
summon access prepare cloudflare --origin HTTPS --owner summon
summon access apply cloudflare --plan PLAN_ID --confirm --token-file PATH
summon access revoke cloudflare --confirm
summon codex status
summon codex prepare --caller-thread-id ID [--tools-pipe PATH --ipc-pipe PATH]
```

`remote --stop-local` 停止本安装管理且当前选择的本机工作区。令牌文件可用 `-` 从标准输入读取。命令输出 JSON。退出码 `0` 表示操作已处理，`1` 表示失败，`2` 表示需要组件、授权或恢复操作。外部 Cloudflare 入口使用已发布的主机名，代理目标填本机 Web 地址并保留请求 Host。Tailscale 使用官方客户端的私网 Serve，遇到现有映射时可选择另一 HTTPS 端口。

Codex 的准备命令保存本机端点。打开使用当前默认权限的本机会话后，由用户在主 Bot 引导或「模型与引擎」中授权 WORK。Mac 需要填写运行中的 Codex 工具与会话 IPC 套接字。CHAT 订阅单独导入。

API 使用工作区访问令牌。可从桌面本机设置复制令牌，程序化操作也可从部署配置的私有 `web.accessToken` 字段读取。模型引导依次调用 `/api/model-settings/onboarding/reply`，按返回的 `options` 提交 `action` 与 `value`。等待首条真实回复时查询 `GET /api/model-settings/onboarding`，或提交 `action=progress`。进入真实房间后按 `guide.options` 向 `/api/model-settings/onboarding/advance` 提交 `step` 与 `action`。

## 构建候选

在目标系统以本机架构的 Node 24 安装根生产依赖与桌面依赖，然后运行 `npm run release:desktop -- --candidate`。从当前提交构建的候选位于 `.relay/client-builds`。Actions 的 `Client releases` 可通过 `candidate=true` 构建候选。

下载和更新先查设备本机发行物，再查 GitHub Releases。正式发布见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。
