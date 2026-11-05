# 客户端发行与更新

Summon Bot 使用普通网页、Windows/macOS Electron、Android Compose 和 iOS SwiftUI。网页及桌面共用正式页面。网页定稿、同步原生实现并提交推送后，Windows 在本地打包并只就位本机；GitHub 上的 Windows、macOS 和 Android 发行包统一由 GitHub Actions 构建发布。本机不上传安装包到 GitHub。iOS 使用 GitHub Actions 签名上传并通过 TestFlight 内部测试分发，操作见 docs/IOS_TESTFLIGHT.md。

## 下载来源

客户端下载与更新按设备本机、GitHub 的顺序查找：

1. 先查询设备自己的 `http://127.0.0.1:8787`。本机包在 `D:/Relay-Bot-data/client-releases/<platform>/<arch>`；已有有效发行物时优先使用，不再请求该目标的远端版本。
2. 本机不可用、没有对应发行物，或 Windows/Android 本机包下载失败时，使用公开仓库 [buyun00/Summon-Bot 的 Releases](https://github.com/buyun00/Summon-Bot/releases)。安装包从 GitHub 直接下载，不经过正式主机转发，也不依赖源码目录。

网页“客户端下载与更新”使用相同来源顺序。本机包的构建号至少应达到当前正式版本，过时文件不参与下载选择。远程 `GET /api/releases` 仅返回 GitHub 版本目录和直接下载链接；本机入口可读取本机发行物，`?local=1` 仅查询本机且不访问 GitHub。浏览器不允许本机网络访问时继续使用 GitHub。

每个目标使用固定的 GitHub Release 标签：`client-windows-x64`、`client-windows-arm64`、`client-macos-universal`、`client-android-universal`。每个标签仅保留最新版安装包和元数据。发行描述包含当前 JSON 版本目录，`latest.json` 供原生端查询，Windows 的 `latest.yml` 供 Electron 更新器读取。发布先上传安装包，再切换元数据，最后删除被替代的资产。

## 版本和 Windows 发布

各端读取根目录 `release.json` 的 `version`、递增 `buildNumber`、正式地址和 GitHub 仓库。每次发布先递增版本：

```powershell
npm run release:version
```

此命令同步包、锁文件和 Xcode 工程版本，Android 读取同一 JSON。提交并推送本次代码后运行：

```powershell
npm run release:all
```

该命令从 Git 当前提交构建并安装正式 Web/后端，正常停止和恢复既有服务与 Codex 连接器，然后只在本地构建 Windows 桌面端，产物发布到本机发行目录后即结束。本机不上传 GitHub，也不构建 Android。首次需要桌面依赖时执行 `npm ci --prefix desktop --no-audit --no-fund`。

也可分别执行：

```powershell
npm run release:web -- --committed-only
npm run release:desktop
```

制作阶段 `npm run release:web` 仍可安装工作区网页效果，不会发布客户端。Windows 的 `release:desktop` 默认发布到本机发行目录，`--publish` 同样只发布本机。`--github` 仅允许在 GitHub Actions 中使用；本机调用会直接提示改用 Actions。发布完成清理对应中间目录，不通过本机重试 GitHub 上传。

若运行时下载受网络影响，可将同版本 Electron ZIP 的绝对路径放入 `SUMMON_ELECTRON_DIST`。

## GitHub Actions

[Client releases 工作流](../.github/workflows/client-releases.yml) 在主分支的 `release.json` 版本变更时运行，客户端改动在定稿时一并递增版本；也可手动选择 `cloud`、`macos`、`android` 或 `windows`。`cloud` 和版本推送均构建 Windows、macOS 和 Android；各平台的 GitHub 发行物直接由对应 runner 构建发布。工作流只安装依赖、构建和发布，不运行测试，不创建后端或预览服务。

macOS 使用 GitHub 的 Mac runner 构建 Intel + Apple Silicon universal DMG/ZIP。使用付费 Apple Developer 团队的 Developer ID Application 证书签名，启用 Hardened Runtime，并完成 Apple 公证和 App 票据附加。缺少证书或公证失败时停止发布；准备方法见 [macOS 签名与公证](MACOS_SIGNING.md)。客户端仍提示新版本并打开 DMG 下载，由用户覆盖安装。

Android 使用 Linux runner、Java 17 和仓库的 Gradle wrapper 构建正式 APK。必须沿用现有签名身份，在 GitHub Actions Secrets 中配置：

- `SUMMON_ANDROID_KEYSTORE_BASE64`：现有 keystore 的 Base64 内容。
- `SUMMON_ANDROID_KEY_ALIAS`：现有别名。
- `SUMMON_ANDROID_STORE_PASSWORD`、`SUMMON_ANDROID_KEY_PASSWORD`：现有密码。

正式签名原件继续留在正式数据根的私有签名配置中，GitHub 仅持有加密 Secrets；密钥和密码不进入源码、日志或发行物。CI 缺少签名配置时直接报告错误，不生成新身份。构建完成后 APK 直接发布 GitHub，不回传正式主机。

## 客户端更新

Windows：首次下载 EXE 安装到当前用户目录。之后应用启动及运行期间自动检查更新，下载完成后在“客户端下载与更新”选择“重启并更新”。本机探测最长 1.2 秒，本机查询或下载失败则直接转 GitHub。

macOS：网页内容刷新即可更新；外壳通过 DMG 手动覆盖安装。检查版本同样先本机、再 GitHub。

Android：进入前台后检查版本，优先使用已经下载到应用缓存的对应 APK。下载时由系统确认覆盖安装；首次可能需要允许此应用安装未知来源应用。本机发行服务缺失时使用 GitHub，与手机设置的业务服务地址无关。

iOS：GitHub Actions 从同一提交签名归档并上传 TestFlight，处理完成后分发到本应用内部组；安装与更新由 TestFlight 完成。详见 [iOS 发布与推送教程](IOS_TESTFLIGHT.md)。

## 正式环境和清理

后端仍只运行 `D:/Relay-Bot-app` 的正式安装，使用 `D:/Relay-Bot-data` 数据，入口和端口不变。源码 `dist` 仅供后端构建。Windows 本机发行目录不作为后端中间目录清理，各目标仅保留当前发行物。旧的远程包上传接口和发布令牌不再使用。

网页不再注册 Service Worker 或提供 PWA 离线页面。`/sw.js` 只清理原离线页面缓存并注销自身；聊天缓存、草稿和用户文件继续保留。
