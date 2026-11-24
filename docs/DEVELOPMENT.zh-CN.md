[English](DEVELOPMENT.md) | [简体中文](DEVELOPMENT.zh-CN.md)

# 开发方式与约定

仓库级总约定见 [AGENTS.md](../AGENTS.md)；用户后续明确指令优先。

## 1. 命名与目录边界

- 产品展示名统一为 `Summon Bot`，GitHub 仓库名为 `Summon-Bot`，根 npm 包名为 `summon-bot`，工作区包命名空间为 `@summon/*`，脚本命令前缀为 `summon:*`，代码类型前缀为 `Summon`，环境变量前缀为 `SUMMON_`。
- 现有源码、后端安装与数据目录位置固定不变；桌面端与 Android 沿用既有应用 ID 与签名身份；iOS 工程使用 `ios/Summon.xcodeproj`，Bundle ID 为 `org.lin0.summon`，并接入生产 APNs 推送。
- 客户端升级时一次性迁移旧本地配置、凭据与缓存，成功后删除旧项，不保留双轨兼容层。

## 2. 固定开发与发布流程

1. **网页先制作与调试**：新功能与界面改动先在网页端实现，并通过浏览器在唯一正式入口查看调试效果。制作阶段可直接用 `npm run release:web` 将未提交的工作区修改安装到正式网页；不提前提交定稿版本，也不提前发布桌面或手机安装包。
2. **同步原生端与桌面代码**：网页定稿后，将确定的行为、视觉与协议变更同步实现到 iOS（SwiftUI）、Android（Kotlin/Compose）以及必要的 Electron 桌面端代码。网页修改不会自动生成原生移动端界面。
3. **统一基线提交并推送**：同步完成后，按 `npm run release:version` 递增版本与构建号（若本次发布客户端），提交并推送代码。后续各端产物均以同一 Git 提交为基线。
4. **分渠道构建发布**：
   - Windows 桌面端在本地打包并仅发布到本机发行目录（`D:/Relay-Bot-data/client-releases`），不从本机上传 GitHub；
   - GitHub Releases 上的 Windows、macOS（仅 Apple Silicon arm64，Developer ID 签名与 Apple 公证）与 Android 正式包统一由 GitHub Actions 从同一提交构建并发布；
   - iOS 由 GitHub Actions 签名归档并上传至 TestFlight 内部测试组。
5. **协议变更顺序**：若本次改动涉及协议版本升级，须先确保同提交的 Windows 本机包、GitHub Releases 与 TestFlight 内部版本均可取得，再切换正式网页与后端。

## 3. 四类终端形态与更新方式

| 终端 | 技术实现 | 更新方式 |
| --- | --- | --- |
| 网页 | 普通浏览器网页（已退出 PWA） | 正式部署后刷新即生效；旧 `/sw.js` 仅注销自身并清理离线页缓存，保留草稿与必要设置 |
| 桌面端（Windows / macOS） | Electron 外壳加载正式网页 | 网页内容随正式网页刷新生效；Windows 外壳自动检查并重启更新，macOS 下载签名公证后的 arm64 DMG 手动覆盖安装 |
| Android | Kotlin / Jetpack Compose 原生客户端 | 前台检查新版，下载 APK 交系统确认覆盖安装 |
| iOS | SwiftUI 原生客户端（iOS 26+） | 通过 TestFlight 内部测试组安装与更新 |

> 网页与 Electron 桌面端共用同一正式页面，因此制作阶段已部署的网页改动在桌面端刷新后也会同步显示。

## 4. 固定位置与发行来源

| 用途 | 位置 |
| --- | --- |
| 源码 Git 仓库 | `D:/Relay-Bot` |
| 后端程序安装 | `D:/Relay-Bot-app` |
| 正式业务数据 | `D:/Relay-Bot-data` |
| Windows 本机发行物 | `D:/Relay-Bot-data/client-releases` |
| 各平台远程发行物 | GitHub Releases：`buyun00/Summon-Bot` |

客户端下载与更新先查询本机 `http://127.0.0.1:8787`，无有效本机发行物或本机不可用时直接从 GitHub Releases 下载，不经正式主机转发。各发布目标仅保留当前最新版，安装包绝不提交进源码 Git，也不长期滞留源码 `dist/`。操作细节见 [客户端发行与更新](CLIENT_RELEASES.zh-CN.md)。

## 5. 纯开发阶段约束与交付准则

- **唯一正式环境**：只运行 `https://bot.lin0.org`（本机 `http://127.0.0.1:8787`），不再创建或启动开发、测试、临时预览服务及独立数据根。源码修改通过 [运行维护](OPERATIONS.zh-CN.md) 中的正式构建安装流程交付。
- **只保留最新版**：每次交付同步更新所有运行引用，并清理被替代的旧版本、旧配置、过时文档与构建中间目录；不保留回退副本或兼容层。数据结构变更通过一次性转换保留有效对话、记忆、工具记录与用户文件，完成后移除转换代码。
- **不主动扩展验证范围**：除非用户另行明确要求，不自动运行回归、单元、集成、浏览器或真实模型测试，不补写测试或恢复已删除测试入口；不计算或比对文件/目录/数据哈希；不以额外验收报告或回执作为交付前置条件。
- **环境与凭据**：构建与安装使用 Node.js 24+；模型与签名凭据沿用正式数据根的私有配置，不为看效果向模型发送样例任务或填充已清空的历史对话。
- **如实处理错误与交付**：遇到真实运行或构建错误时直接修复并继续原任务；只有具体缺失条件确实导致无法继续时才报告阻塞。交付时如实说明已修改、已执行与仍未完成的事项。
