# Summon Bot 桌面端

Windows x64 和 Apple Silicon macOS 的 All-in-One 桌面安装包内置 Electron、Node、Web 与本机服务端。

- **开箱即用**：Windows 安装完成后自动启动；首次打开自动初始化本机数据目录与默认「Summon 工作区」，并平滑管理版本升级时的后台服务重启。
- **极简引导**：首启播放全屏开场动效，只需接通并验证第一个可用 AI（自动探测本机 Codex / Grok 登录，或使用订阅授权 / API Key），随后直接进入专注模式的默认「Summon」群，由 Pi 主持扫描本机工具、登记项目目录与连接云端中枢，完成后解锁完整工作台。
- **远程多端互联**：通过云端中枢（默认 `https://bot.lin0.org`，支持自部署）在 iOS / Android / 其他电脑远程访问本机群聊，由 Pi 在「Summon」群内直接查看状态并操作连接/断连。

## 构建候选

在目标系统以本机架构的 Node 24 安装根生产依赖与桌面依赖，然后运行 `npm run release:desktop -- --candidate`。产物位于 `.relay/client-builds` 子目录。正式发布见 [客户端发行与更新](../docs/CLIENT_RELEASES.zh-CN.md)。
