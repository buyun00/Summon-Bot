[English](CLIENT_RELEASES.md) | [简体中文](CLIENT_RELEASES.zh-CN.md)

# 客户端发行与更新

Summon Bot 提供四类终端：普通网页、Windows / macOS（Apple Silicon）Electron 桌面端、Kotlin / Compose 原生 Android 与 SwiftUI 原生 iOS 26。网页与桌面端共用同一套正式页面。

网页定稿、同步原生实现并提交推送后：
- **Windows**：在本机打包并仅就位至本机发行目录（不从本机上传 GitHub）。
- **GitHub Releases（Windows / macOS / Android）**：统一由 GitHub Actions 从同一提交独立构建并发布。
- **iOS**：由 GitHub Actions 签名归档、上传并通过 TestFlight 内部测试组分发，操作见 [iOS 发布与推送教程](IOS_TESTFLIGHT.zh-CN.md)。

## 1. 下载与更新来源顺序

Windows x64 提供 EXE 安装包，Apple Silicon macOS 提供 arm64 DMG，Android 提供通用 APK。iOS 与 Android 首次连接时填写实例地址与访问令牌；桌面端运维命令与候选构建见 [桌面端说明](../desktop/README.md)。

各端查询与下载严格按以下顺序回退：

1. **设备本机优先**：先查询本机 `http://127.0.0.1:8787`。本机发行物位于 `D:/Relay-Bot-data/client-releases/<platform>/<arch>`；存在且构建号不低于当前正式版本时优先使用，不再请求该目标的远端版本。
2. **GitHub Releases 直接获取**：本机不可用、无对应有效发行物，或 Windows / Android 本机包下载失败时，直接从公开仓库 [buyun00/Summon-Bot Releases](https://github.com/buyun00/Summon-Bot/releases) 下载，不经过正式主机转发，也不依赖源码目录。

网页“客户端下载与更新”遵循相同来源顺序。远程 `GET /api/releases` 仅返回 GitHub 版本目录与直链；本机入口可读取本机发行物，`?local=1` 仅查本机且不访问 GitHub。浏览器禁止访问本机回环网络时自动回退 GitHub。

GitHub Release 固定使用 3 个滚动标签：
- `client-windows-x64`
- `client-macos-arm64`
- `client-android-universal`

每个标签仅保留当前最新版安装包与元数据（`latest.json` 供原生端查询，Windows 的 `latest.yml` 供 Electron 自动更新器读取）。发布时先上传新安装包，再切换元数据，最后删除被替代资产。

## 2. 版本递增与 Windows 本地发布

各端统一读取根目录 `release.json` 中的 `version`、递增 `buildNumber`、正式入口地址与 GitHub 仓库名。每次正式发布前先递增版本：

```powershell
npm run release:version
```

该命令同步更新根包、工作区包、锁文件与 Xcode 工程版本，Android 构建直接读取同一 `release.json`。提交并推送本次改动后，在仓库根目录执行：

```powershell
npm run release:all
```

该命令基于当前 Git 提交构建 Windows 本机发行包、正式网页与后端：
- **同协议发布**：可直接更新正式网页与后端，客户端沿各自渠道交付。
- **协议切换发布**：先准备 Windows 本机包，再由安装器核对对应 GitHub Releases 与 TestFlight 内部测试组的实际可用状态（已配置 App Store Connect 时直接查询 Apple，否则读取同提交 Actions 分发结果）。
- 首次准备桌面构建依赖可运行：`npm ci --prefix desktop --ignore-scripts --no-audit --no-fund`。

也可按需单独执行：

```powershell
npm run release:desktop
npm run release:web -- --committed-only
```

- 网页制作阶段可运行 `npm run release:web` 安装与现行协议兼容的工作区构建，供唯一正式入口实时查看效果。
- Windows 的 `release:desktop` 默认仅发布至本机发行目录（`--publish` 同样只发布本机，`--github` 仅供 GitHub Actions 使用）。重试 `release:all` 时会复用同提交已就位的 Windows 本机包。
- 若 Electron 运行时下载受网络影响，可将对应版本的 Electron ZIP 绝对路径写入环境变量 `SUMMON_ELECTRON_DIST`。

## 3. GitHub Actions 自动化构建

[Client releases 工作流](../.github/workflows/client-releases.yml) 在主分支 `release.json` 变更时自动触发，也支持手动选择 `cloud`、`windows`、`macos` 或 `android` 运行。工作流仅安装依赖、构建与发布，不运行测试，不启动额外预览服务。

- **macOS（Apple Silicon arm64）**：在 GitHub Mac runner 上构建 arm64 DMG，使用 Developer ID Application 签名与 Hardened Runtime，完成 Apple 公证并附加票据。配置方式见 [macOS 签名与公证](MACOS_SIGNING.zh-CN.md)。
- **Android**：使用 Linux runner、Java 17 与仓库 Gradle Wrapper 构建正式 APK。正式签名沿用既有身份，通过以下 GitHub Actions Secrets 注入（原件仅保留在正式主机私有签名配置中）：
  - `SUMMON_ANDROID_KEYSTORE_BASE64`
  - `SUMMON_ANDROID_KEY_ALIAS`
  - `SUMMON_ANDROID_STORE_PASSWORD`
  - `SUMMON_ANDROID_KEY_PASSWORD`
- **iOS**：由 [ios-testflight.yml](../.github/workflows/ios-testflight.yml) 在主分支 `release.json` 变更或手动触发时签名归档并上传 TestFlight 内部组。

## 4. 各端更新体验

- **Windows 桌面端**：EXE 安装至当前用户目录，首次打开在开箱页选择本机正式实例或填写远程地址与访问令牌登录。应用在启动与运行期间自动检查更新（本机探测最长 1.2 秒，失败转 GitHub），下载完成后在“客户端下载与更新”点击“重启并更新”。
- **macOS 桌面端**：网页内容随正式部署刷新生效；桌面外壳检查新版后打开 DMG 下载，由用户手动覆盖安装。
- **Android**：切回前台自动检查新版，优先复用应用缓存中已下载的对应 APK，下载后交由系统确认覆盖安装（首次需允许安装未知来源应用）。
- **iOS**：通过 TestFlight 内部测试组接收并更新版本，详见 [iOS 发布与推送教程](IOS_TESTFLIGHT.zh-CN.md)。

## 5. 正式环境边界与 PWA 退出

- 后端仅运行 `D:/Relay-Bot-app` 中的正式安装，业务数据位于 `D:/Relay-Bot-data`，入口与端口固定不变。源码 `dist/` 仅供后端构建中转；`D:/Relay-Bot-data/client-releases` 不作为后端构建中间目录清理，各目标只保留当前最新发行物。
- 网页不再提供 PWA 安装或离线缓存。旧 `/sw.js` 仅用于清理历史离线页面缓存并注销自身，同时保留聊天草稿与连接设置等必要本地数据。
