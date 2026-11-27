# 项目开发约定

适用于整个仓库。以下规则按用户 2026-10-21 的明确要求执行；用户后续明确指令优先。

- 产品展示名统一为 `Summon Bot`，GitHub 仓库名为 `Summon-Bot`，根 npm 包使用小写 `summon-bot`，包命名空间为 `@summon/*`，命令前缀为 `summon:*`，代码类型前缀为 `Summon`，环境变量前缀为 `SUMMON_`。按用户 2026-11-03 的要求，现有目录、应用 ID 和签名身份继续沿用。2026-11-05 用户另行指定 iOS 工程改为 Summon，Bundle ID 改为 org.lin0.summon，并接入生产 APNs 推送；其他平台身份不变。
- 只运行一个正式环境：统一使用 `D:/Relay-Bot-data`，正式入口为 `https://bot.lin0.org`（本机 `http://127.0.0.1:8787`）。按用户 2026-11-27 的要求，本机运行主体统一由独立安装的 Tauri 桌面客户端内嵌运行时（`%LOCALAPPDATA%/Summon Bot/summon-runtime`）直接托管 `D:/Relay-Bot-data`，不再保留独立的 `D:/Relay-Bot-app` 并行副本。不再创建或启动开发、测试、临时预览服务及独立数据根，不把其他端口当作交付入口。
- 终端形态固定为四类：普通网页、Windows/macOS 的 Tauri 桌面端、SwiftUI 原生 iOS、Kotlin/Compose 原生 Android。桌面端复用正式网页并自带本地运行时；网页不再采用 PWA 形态。现有 PWA 的退出须同时处理已注册的 Service Worker 和离线缓存。
- 双轨开发与交付流程（2026-11-27 确立）：
  - **外部人工/IDE 直接开发（快轨 + 正式轨）**：固定为“网页先制作和调试效果 → 定稿 → 同步原生手机端及必要的桌面代码 → 升版本提交并推送代码 → GitHub Actions 统一打包发布各端”。制作阶段可在外部通过 `npm run release:web` 将未提交的工作区修改快速同步至本机运行中的 Tauri `summon-runtime` 并平滑重启，供用户在唯一入口实时看效果；不提前发布客户端更新包。定稿并同步原生端后递增版本并推送。
  - **Summon 自研群开发（彻底隔离轨）**：在 Summon 内部开发群进行的修改只操作源码仓库 `D:/Relay-Bot`，**严禁在 Summon 内部会话中调用 `release:web` / `release:all` 或直接启停本机服务**（避免排空死锁与进程树强杀）；改完自检后统一 `npm run release:version`、提交并推送到 GitHub，由 GitHub Actions 自动打包发布，本机独立 Tauri 客户端检测到新版本后由用户一键「安装更新」完成整体升级。两边协同以 Git `main` 为唯一交接面，动源码前先检查 `git status`，发现未提交工作区改动时先向用户确认，绝不互踩。
  - 按用户 2026-11-04 的要求，Windows 本地打包只发布到本机发行目录，不从本机上传 GitHub；按用户 2026-11-26 的要求，本地与 GitHub Actions 均停止 Electron 打包，桌面端统一仅构建 Tauri（`windows/x64-tauri`、`macos/arm64-tauri`）；GitHub 上的 Windows、macOS、Android 发行包统一由 GitHub Actions 从同一提交构建并发布。macOS 仅支持 Apple Silicon（arm64），不再构建或发布 Intel / universal 包；使用 Developer ID Application 签名和 Apple 公证，支持应用内自动下载与一键更新，配置见 docs/MACOS_SIGNING.zh-CN.md；iOS 使用 GitHub Actions 签名上传并通过 TestFlight 内部测试分发，操作见 docs/IOS_TESTFLIGHT.zh-CN.md。
- 客户端下载和更新先查设备本机发行物，再查公开仓库 `buyun00/Summon-Bot` 的 GitHub Releases。Windows 本地最新包保存在 `D:/Relay-Bot-data/client-releases`；GitHub 发行包由 Actions 独立构建发布。远程下载直接从 GitHub 获取，不再通过正式主机的发行目录转发安装包。各平台和架构只保留当前发行物，不把安装包提交到源码 Git，不另起分发服务，不将本机发行目录当作后端构建中间目录清理。发行下载和自动更新功能须实际实现后才能宣称可用。
- 当前是纯开发阶段，只保留最新版代码、发行物、能力服务和生效配置。每次修改交付时同步更新所有运行引用并清理被替代的旧版本、旧配置和构建中间目录，不保留备份、回退副本或并行旧服务。
- 不为旧版本保留兼容层、旧入口或旧配置回退分支。需要调整现有数据时一次性转换到当前格式，完成后移除转换代码和过时配置；有效对话、记忆、工具记录及用户文件继续保留。
- 围绕当前需求完成必要修改，完成后直接交付；已授权运行、启动或部署的工作直接继续。
- 用户未另行明确要求时，不运行回归、单元、集成、浏览器、真实模型或其他测试，不补写测试，不恢复已删除的测试及测试入口。
- 不计算或比对文件、目录、发行物、数据的哈希，不追加完整性扫描或来源校验。
- 不追加重复验收，不把测试、哈希、额外回执、证据文件或流程报告作为交付前置条件，也不据此扩大任务范围。
- 实际需要运行时，只完成必要的构建、配置和启动；出现真实错误时处理该错误，不顺带扩展验证范围。
- 只有具体问题确实使当前工作无法继续时才报告阻塞，说明出错操作、实际错误和缺少的条件；不能因未跑测试、未做哈希或未补验收材料而停工。
- 如实说明已修改、已启动和仍未完成的内容。历史测试结果、哈希与验收记录仅作为历史保存，不构成后续规则，不自动补齐其中的未验证项。

开发说明见 [docs/DEVELOPMENT.zh-CN.md](docs/DEVELOPMENT.zh-CN.md)。
