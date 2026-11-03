# Summon Bot 桌面端

Windows/macOS 的 Electron 客户端，加载正式网页 `https://bot.lin0.org`，共用同一后端和界面。网页页面不开放 Node.js 权限；桌面桥接只提供版本、检查更新和重启安装。

Windows 默认在本地执行 `npm ci --prefix desktop --no-audit --no-fund`，然后运行 `npm run release:desktop -- --publish`，使用 NSIS 当前用户安装。macOS 默认由 GitHub Actions 生成 Intel + Apple Silicon universal DMG/ZIP，仅做 ad-hoc 签名，无需开发者账户，下载后手动覆盖安装。

下载与更新先查设备本机发行物，再查 GitHub Releases，远程安装包直接从 GitHub 下载。发行目录、更新方式和版本号见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。日常制作直接查看正式网页，不另开 Electron 开发服务。
