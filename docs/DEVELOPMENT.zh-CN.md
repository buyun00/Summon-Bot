[English](DEVELOPMENT.md) | [简体中文](DEVELOPMENT.zh-CN.md)

# 开发方式与约定

仓库级总约定见 [AGENTS.md](../AGENTS.md)；用户后续明确指令优先。

## 1. 命名与目录边界

- 产品展示名统一为 `Summon Bot`，GitHub 仓库名为 `Summon-Bot`，根 npm 包名为 `summon-bot`，工作区包命名空间为 `@summon/*`，脚本命令前缀为 `summon:*`，代码类型前缀为 `Summon`，环境变量前缀为 `SUMMON_`。
- 现有源码、后端安装与数据目录位置固定不变；桌面端与 Android 沿用既有应用 ID 与签名身份；iOS 工程使用 `ios/Summon.xcodeproj`，Bundle ID 为 `org.lin0.summon`，并接入生产 APNs 推送。
- 客户端升级时一次性迁移旧本地配置、凭据与缓存，成功后删除旧项，不保留双轨兼容层。

## 2. 双轨开发与发布流程

1. **外部直接开发（快轨调试 → 定稿发布）**：
   - **网页先制作与调试**：新功能与界面改动先在网页端实现，并在唯一正式入口查看效果。制作阶段可在外部终端运行 `npm run release:web` 将未提交的工作区修改快速同步到本机运行中的 Tauri `summon-runtime` 并平滑重启；不提前发布客户端更新包。
   - **同步原生端与桌面代码**：网页定稿后，将确定的行为、视觉与协议变更同步实现到 iOS（SwiftUI）、Android（Kotlin/Compose）以及必要的 Tauri 桌面端代码（`desktop-tauri/`）。
   - **统一基线提交并推送**：按 `npm run release:version` 递增版本与构建号，提交并推送至 `main`，由 GitHub Actions 统一出包。
2. **Summon 内部自研群开发（彻底隔离轨）**：
   - 在 Summon 自研开发群进行修改时，Bot 与工作引擎只修改 `D:/Relay-Bot` 源码，**严禁在 Summon 内部会话执行 `release:web` / `release:all` 或直接启停正式服**（防止排空死锁与进程树终止）。
   - 改前先检查 `git status` 并同步最新 `main`（若有未提交改动先向宿主确认防撞车）；改完做语法与构建预检后执行 `npm run release:version`、提交并推送至 GitHub。
   - GitHub Actions 打包发布后，本机独立 Tauri 客户端自动检测并下载新版，由用户点击「安装更新」一次性更新桌面端、网页与内置后端运行时。
3. **分渠道构建发布**：
   - GitHub Releases 上的 Windows（`windows/x64-tauri`）、macOS（仅 Apple Silicon `macos/arm64-tauri`，Developer ID 签名与 Apple 公证）与 Android 正式包统一由 GitHub Actions 从同一提交构建并发布；
   - iOS 由 GitHub Actions 签名归档并上传至 TestFlight 内部测试组；
   - 如外部开发需在 Windows 本地提前验证安装包，可运行 `npm run release:desktop:tauri` 仅发布至本机发行目录（`D:/Relay-Bot-data/client-releases`），不从本机上传 GitHub。
4. **协议变更顺序**：若本次改动涉及协议版本升级，须先确保同提交的客户端发行包在 GitHub Releases 与 TestFlight 内部测试组均可取得，再切换正式环境。

## 3. 四类终端形态与更新方式

| 终端 | 技术实现 | 更新方式 |
| --- | --- | --- |
| 网页 | 普通浏览器网页（已退出 PWA） | 随本机 Tauri 内置运行时更新后刷新即生效；旧 `/sw.js` 仅注销自身并清理离线页缓存 |
| 桌面端（Windows / macOS） | Tauri 外壳 + 内嵌 `summon-runtime`（`desktop-tauri`） | 后台自动检测并下载新版，点头像弹窗菜单「安装更新」自动停服覆盖并重启，同步升级桌面端、网页与本地后端 |
| Android | Kotlin / Jetpack Compose 原生客户端 | 前台检查新版并后台自动下载 APK，点头像菜单「安装更新」交系统覆盖安装 |
| iOS | SwiftUI 原生客户端（iOS 26+） | 通过 TestFlight 内部测试组安装与更新 |

## 4. 固定位置与发行来源

| 用途 | 位置 |
| --- | --- |
| 源码 Git 仓库 | `D:/Relay-Bot` |
| 本机运行主体 | 独立 Tauri 桌面端内置运行时（`%LOCALAPPDATA%/Summon Bot/summon-runtime`） |
| 正式业务数据 | `D:/Relay-Bot-data` |
| Windows 本机发行物（可选本地预发） | `D:/Relay-Bot-data/client-releases` |
| 各平台远程发行物 | GitHub Releases：`buyun00/Summon-Bot` |

客户端下载与更新先查询本机 `http://127.0.0.1:8787`，无有效本机发行物或本机不可用时直接从 GitHub Releases 下载，不经正式主机转发。各发布目标仅保留当前最新版，安装包绝不提交进源码 Git，也不长期滞留源码 `dist/`。操作细节见 [客户端发行与更新](CLIENT_RELEASES.zh-CN.md)。

## 5. 纯开发阶段约束与交付准则

- **唯一正式环境**：只运行 `https://bot.lin0.org`（本机 `http://127.0.0.1:8787`），不再创建或启动开发、测试、临时预览服务及独立数据根。源码修改通过 [运行维护](OPERATIONS.zh-CN.md) 中的正式构建安装流程交付。
- **只保留最新版**：每次交付同步更新所有运行引用，并清理被替代的旧版本、旧配置、过时文档与构建中间目录；不保留回退副本或兼容层。数据结构变更通过一次性转换保留有效对话、记忆、工具记录与用户文件，完成后移除转换代码。
- **不主动扩展验证范围**：除非用户另行明确要求，不自动运行回归、单元、集成、浏览器或真实模型测试，不补写测试或恢复已删除测试入口；不计算或比对文件/目录/数据哈希；不以额外验收报告或回执作为交付前置条件。
- **环境与凭据**：构建与安装使用 Node.js 24+；模型与签名凭据沿用正式数据根的私有配置，不为看效果向模型发送样例任务或填充已清空的历史对话。
- **如实处理错误与交付**：遇到真实运行或构建错误时直接修复并继续原任务；只有具体缺失条件确实导致无法继续时才报告阻塞。交付时如实说明已修改、已执行与仍未完成的事项。
