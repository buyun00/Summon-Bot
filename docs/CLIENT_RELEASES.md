# 客户端发行与更新

Summon Bot 使用普通网页、Windows/macOS Electron 桌面端、Android Compose 和 iOS SwiftUI。网页及桌面共用 `https://bot.lin0.org` 页面，手机端使用原生组件。开发顺序遵循 [DEVELOPMENT.md](DEVELOPMENT.md)：网页制作、定稿、同步原生实现、提交推送，再打包发布。

## 目录和入口

源码位于 `D:/Relay-Bot`，正式服务安装在 `D:/Relay-Bot-app`。客户端发行包存入 `D:/Relay-Bot-data/client-releases/<platform>/<arch>`，复用正式 Web 服务，下载不依赖另一个监听端口。源码 `dist` 仅供后端构建，不能作为客户端正式下载目录。

网页“连接应用 → 客户端下载与更新”显示实际已发布的 Windows、macOS 和 Android 版本。`GET /api/releases` 提供同一份版本目录；`GET /api/releases/<platform>/<arch>/latest.json` 提供单个平台的最新版本和下载地址。只分发专用发行目录中已发布的文件，不公开其他业务数据。

每个目标仅保留当前发行物。发布先复制完整产物，再替换 `current.json` 指向的新发行目录，然后删除旧目录。`latest.yml` 和 `latest-mac.yml` 由桌面打包工具生成，供标准更新器读取。桌面下载完整最新版，不依赖服务器保留旧版差分包。

## 版本和 Windows 发布

各端使用根目录 `release.json` 的 `version`、递增的 `buildNumber` 和正式地址。修改版本时运行：

```powershell
npm run release:version -- --version 0.3.1
```

此命令同时更新包版本、锁文件和 Xcode 工程版本；Android 从同一 JSON 读取版本号。完成代码制作后提交并推送，再执行发布。

首次为桌面构建准备依赖：

```powershell
npm install --prefix desktop --no-audit --no-fund
```

Windows 发布当前平台产物并更新正式服务：

```powershell
npm run release:all
```

该命令构建并安装正式 Web/后端，正常停止、更新、恢复现有服务与 Codex 连接器，然后构建和发布 Windows 桌面端、Android APK。完整后端发布从 Git 当前提交导出源码，保留工作区中的其他未提交和未跟踪改动。只有必要的依赖安装、构建及启停，不追加测试或验收流程。此命令不负责提交代码，不会创建预览服务器。

替换程序前先停止 Bot、网关和 Web 等写入者，再停止 Codex 连接器并等待进程退出，避免 Bot 在安装间隙重新拉起连接器、占用待删除的旧发行目录。

也可分别执行：

```powershell
npm run release:web
npm run release:desktop -- --publish
npm run release:android -- --publish
```

不带 `--publish` 的客户端构建输出到 `.relay/client-builds`。发布成功后清理对应中间目录。每次发布必须使用更大的 `buildNumber`，避免原生客户端无法识别新版本。各目标独立记录实际发布状态，不把缺少的 Mac 产物标记成已发布。

若当前环境禁止清理 Android 编译缓存，可加 `--keep-build-cache` 明确保留这些缓存；该选项不保留旧的已发布安装包，也不改变最新版切换流程。

若运行时下载受当前网络影响，可将同版本 Electron ZIP 的绝对路径放入 `SUMMON_ELECTRON_DIST`，打包器会直接使用该运行时归档；无需启动额外服务。

## 桌面更新

Electron 仅承载正式网页，不运行另一份 Summon Bot 后端。页面不具有 Node 权限，桌面版本、检查更新、重启更新通过限定的桥接接口提供。外部链接交给系统浏览器。

Windows 首次使用下载的 EXE 安装到当前用户目录。后续应用启动后及运行期间检查更新，后台下载完成后，在“客户端下载与更新”点击“重启并更新”；草稿先保存，再由标准更新器替换程序并重新打开。无需再次手动走安装向导。网页部署的界面变化刷新后直接生效。

桌面更新优先使用本机正式服务 `http://127.0.0.1:8787`，版本信息和安装包都从该入口获取，直接读取本机发行仓库，不经过公网域名。先用最长 1.2 秒的请求探测本机更新入口；本机无法连接、没有对应发行物，或检查、下载失败时，自动改用 `https://bot.lin0.org`。本机已返回有效的当前版本时无需再请求远端。没有本机服务的其他电脑仍可从域名更新。打包时记录目标平台与架构，Mac universal 包继续使用 universal 发行目录。

macOS 自动更新使用签名的 DMG 和 ZIP，须在 Mac 上完成签名构建，不能用 Windows 构建的文件代替。

## Android 更新和签名

Android 进入前台后检查更新，设置中提供版本、下载进度和安装入口。点击下载安装到本机后，由系统安装程序确认覆盖；首次使用时可能需要允许此应用安装未知来源应用。

Windows 构建默认使用 Android Studio 的 JBR 及当前用户的 Android SDK；也可设置 `JAVA_HOME`、`ANDROID_HOME`。正式签名在首次构建时写入正式数据根的私有签名配置，后续重复使用同一个密钥。密钥和密码不提交源码，也不写入发行包目录。

本机首次接入发行仓库时，沿用此前 Android 构建所用的签名身份并转入正式私有签名配置，避免更换签名导致已安装应用不能覆盖更新。后续只使用当前签名配置，不自动卸载应用或清除设备数据。

## Mac 构建和上传

在 Mac 拉取已发布的同一提交并准备桌面依赖后运行：

```sh
npm run release:desktop
npm run release:ios
```

桌面默认生成包含 Intel 和 Apple Silicon 的 universal DMG/ZIP，需要本机可用的 Apple 签名身份。iOS 使用 Xcode 归档；签名 Team 可通过 `SUMMON_APPLE_TEAM_ID` 指定，或使用工程的本机签名设置。需要导出 IPA 时，将本机的导出设置传入 `--export-options <ExportOptions.plist>`。iOS 暂不接入应用内下载安装。

Mac 桌面构建完成后上传到同一 Windows 发行仓库：

```sh
npm run release:publish -- --input .relay/client-builds/macos-universal --server https://bot.lin0.org --token-file /absolute/path/to/private-publishing-token
```

上传凭据由正式主机首次部署时生成，仅保存在正式数据根的私有配置中；通过私下方式交给 Mac，不提交仓库或放入客户端。上传按块执行，产物全部到达后才切换最新版。手机和桌面只具有读取发行包的能力，不携带发布凭据。

## 网页退出 PWA

网页不再注册 Service Worker，不提供离线页面或 PWA 安装入口。`/sw.js` 只用于让已安装的旧离线组件退出：删除 Summon Bot 离线页面缓存并注销自身，不创建新的缓存，也不主动跳转或刷新正在编辑的页面。普通网页再次打开时也会注销遗留组件；聊天缓存、草稿及用户文件继续保留。
