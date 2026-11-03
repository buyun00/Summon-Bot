# Relay 桌面端

Windows/macOS 的 Electron 客户端，加载正式网页 `https://bot.lin0.org`，共用同一后端和界面。网页页面不开放 Node.js 权限；桌面桥接只提供版本、检查更新和重启安装。

在仓库根目录执行 `npm install --prefix desktop --no-audit --no-fund`，然后运行 `npm run release:desktop` 构建当前系统产物。Windows 使用 NSIS 当前用户安装，macOS 使用签名 DMG/ZIP，默认同时包含 Intel 和 Apple Silicon。

发行目录、更新方式、版本号和 Mac 上传命令见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。日常制作直接查看正式网页，不另开 Electron 开发服务。
