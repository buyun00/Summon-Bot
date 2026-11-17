# Summon Bot 桌面端

Windows x64 和 Apple Silicon macOS 的桌面安装包内置 Electron、Node、Web 和服务端。Electron 显示所选实例的网页。

Windows 安装后从开始菜单打开 Summon Bot。默认安装路径是 `%LOCALAPPDATA%\Programs\summon-desktop\Summon Bot.exe`。开箱页可选择本机正式实例，或填写远程地址并用该实例的访问令牌登录。连接后，在同一窗口的正式页面配置聊天模型和 API Key。

本机正式实例使用 `D:/Relay-Bot-data`，入口为 `http://127.0.0.1:8787` 和 `https://bot.lin0.org`。正式服务由现有安装入口启停和升级，关闭窗口后继续运行。[运行维护](../docs/OPERATIONS.md)

## 安装后的运维命令

Windows 运维命令为安装目录的 `summon.cmd`。macOS 运维命令为 `Summon Bot.app/Contents/Resources/summon`。应用连接实例后，可以使用以下命令查询状态或配置远程访问。下例以 `summon` 表示对应命令。

```text
summon status
summon access status tailscale
summon access prepare tailscale --port 443
summon access apply tailscale --plan PLAN_ID --confirm
summon access revoke tailscale --confirm
summon access prepare cloudflare --origin HTTPS --owner external
summon access prepare cloudflare --origin HTTPS --owner summon
summon access apply cloudflare --plan PLAN_ID --confirm --token-file PATH
summon access revoke cloudflare --confirm
```

`summon status` 查询内嵌运行时版本与当前连接。命令输出 JSON。退出码 `0` 表示操作已处理，`1` 表示失败，`2` 表示需要组件、授权或恢复操作。Cloudflare 隧道令牌文件可用 `-` 从标准输入读取。外部 Cloudflare 入口使用已发布的主机名，代理目标填本机 Web 地址并保留请求 Host。Tailscale 使用官方客户端的私网 Serve，遇到现有映射时可选择另一 HTTPS 端口。

Electron 通过已验证的部署机登录会话读取启动信息，然后加载该实例的正式网页。桌面设置页和网页都提供客户端更新入口。

## 构建候选

在目标系统以本机架构的 Node 24 安装根生产依赖与桌面依赖，然后运行 `npm run release:desktop -- --candidate`。本机候选的桌面外壳和内嵌运行时都取自当前工作区，产物位于命令返回的 `.relay/client-builds` 子目录。Actions 的 `Client releases` 可通过 `candidate=true` 从该次检出的代码构建候选。

下载和更新先查设备本机发行物，再查 GitHub Releases。正式发布见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。
