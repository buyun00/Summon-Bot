# 客户端发行与更新

Summon Bot 使用普通网页、Windows/macOS Electron、Android Compose 和 iOS SwiftUI。网页及桌面共用正式页面。网页定稿、同步原生实现并提交推送后，Windows 默认本地打包，macOS 和 Android 默认由 GitHub Actions 构建。iOS 暂不打包发布。

## 下载来源

客户端下载与更新按设备本机、GitHub 的顺序查找：

1. 先查询设备自己的 `http://127.0.0.1:8787`。本机包在 `D:/Relay-Bot-data/client-releases/<platform>/<arch>`；已有有效发行物时优先使用，不再请求该目标的远端版本。
2. 本机不可用、没有对应发行物，或 Windows/Android 本机包下载失败时，使用公开仓库 [buyun00/Summon-Bot 的 Releases](https://github.com/buyun00/Summon-Bot/releases)。安装包从 GitHub 直接下载，不经过正式主机转发，也不依赖源码目录。

网页“客户端下载与更新”使用相同来源顺序。远程 `GET /api/releases` 仅返回 GitHub 版本目录和直接下载链接；本机入口可读取本机发行物，`?local=1` 仅查询本机且不访问 GitHub。浏览器不允许本机网络访问时继续使用 GitHub。

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

该命令从 Git 当前提交构建并安装正式 Web/后端，正常停止和恢复既有服务与 Codex 连接器，然后只在本地构建 Windows 桌面端。Windows 包先发布本机发行目录，再用当前 `gh` 登录身份同步 GitHub Releases；不再本地构建 Android。首次需要桌面依赖时执行 `npm ci --prefix desktop --no-audit --no-fund`。

也可分别执行：

```powershell
npm run release:web -- --committed-only
npm run release:desktop -- --publish
```

制作阶段 `npm run release:web` 仍可安装工作区网页效果，不会发布客户端。客户端不带发布参数时输出到 `.relay/client-builds`；`--publish` 在 Windows 同步本机和 GitHub，`--github` 只发布 GitHub。发布成功清理对应中间目录。若 GitHub 上传中断，保留的输入目录可用 `npm run release:publish -- --input <目录> --github` 继续上传。

若运行时下载受网络影响，可将同版本 Electron ZIP 的绝对路径放入 `SUMMON_ELECTRON_DIST`。

## GitHub Actions

[Client releases 工作流](../.github/workflows/client-releases.yml) 在主分支的 `release.json` 版本变更时运行，客户端改动在定稿时一并递增版本；也可手动选择 `cloud`、`macos`、`android` 或 `windows`。默认云端目标只有 macOS 和 Android，Windows 保留可手动触发的云端构建入口。工作流只安装依赖、构建和发布，不运行测试，不创建后端或预览服务。

macOS 使用 GitHub 的 Mac runner 构建 Intel + Apple Silicon universal DMG/ZIP。无需本地 Mac、Apple Developer 账户或证书，仅做 ad-hoc 签名，不进行 Developer ID 签名或公证。首次打开可能需要在系统“隐私与安全性”手动允许。客户端提示新版本并打开 DMG 下载，用户覆盖安装；不使用依赖开发者签名的自动安装更新。

Android 使用 Linux runner、Java 17 和仓库的 Gradle wrapper 构建正式 APK。必须沿用现有签名身份，在 GitHub Actions Secrets 中配置：

- `SUMMON_ANDROID_KEYSTORE_BASE64`：现有 keystore 的 Base64 内容。
- `SUMMON_ANDROID_KEY_ALIAS`：现有别名。
- `SUMMON_ANDROID_STORE_PASSWORD`、`SUMMON_ANDROID_KEY_PASSWORD`：现有密码。

正式签名原件继续留在正式数据根的私有签名配置中，GitHub 仅持有加密 Secrets；密钥和密码不进入源码、日志或发行物。CI 缺少签名配置时直接报告错误，不生成新身份。构建完成后 APK 直接发布 GitHub，不回传正式主机。

## 客户端更新

Windows：首次下载 EXE 安装到当前用户目录。之后应用启动及运行期间自动检查更新，下载完成后在“客户端下载与更新”选择“重启并更新”。本机探测最长 1.2 秒，本机查询或下载失败则直接转 GitHub。

macOS：网页内容刷新即可更新；外壳通过 DMG 手动覆盖安装。检查版本同样先本机、再 GitHub。

Android：进入前台后检查版本，优先使用已经下载到应用缓存的对应 APK。下载时由系统确认覆盖安装；首次可能需要允许此应用安装未知来源应用。本机发行服务缺失时使用 GitHub，与手机设置的业务服务地址无关。

iOS：保留 SwiftUI 源码和手动 `release:ios` 命令，当前不配置云端构建、签名、IPA 分发或应用内下载安装更新。

## 正式环境和清理

后端仍只运行 `D:/Relay-Bot-app` 的正式安装，使用 `D:/Relay-Bot-data` 数据，入口和端口不变。源码 `dist` 仅供后端构建。Windows 本机发行目录不作为后端中间目录清理，各目标仅保留当前发行物。旧的远程包上传接口和发布令牌不再使用。

网页不再注册 Service Worker 或提供 PWA 离线页面。`/sw.js` 只清理原离线页面缓存并注销自身；聊天缓存、草稿和用户文件继续保留。
