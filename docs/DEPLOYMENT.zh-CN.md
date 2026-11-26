[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

# 交给 AI 部署

这份文档面向操作源码仓库与本机环境的 AI 助手。开始前请先阅读项目约定，再根据当前任务选择启停、网页制作或正式发布；安装与运行细节以 [运行维护](OPERATIONS.zh-CN.md) 和 [客户端发行与更新](CLIENT_RELEASES.zh-CN.md) 为准。

## 1. 可以直接发给 AI 的指令

```text
请帮我部署或更新 Summon Bot。

先阅读 AGENTS.md、docs/DEVELOPMENT.zh-CN.md、docs/DEPLOYMENT.zh-CN.md、
docs/OPERATIONS.zh-CN.md 和 docs/CLIENT_RELEASES.zh-CN.md，再检查当前代码与已有安装。
只处理本次任务负责的文件，保留其他进行中的改动。

沿用仓库约定的唯一正式环境、安装目录和数据根，保留有效对话、
记忆、工具记录与用户文件。需要凭据时读取已有私有配置，
不要把凭据写进代码、聊天、日志或提交。

先在网页制作效果。网页定稿后同步原生手机端与必要的桌面代码，
提交并推送，再按现有流程部署和发布。制作阶段可以更新正式网页，
客户端安装包在定稿后发布；Windows 默认本地打包，macOS 和 Android 默认由 GitHub Actions 构建，
iOS 使用 GitHub Actions 签名上传并通过 TestFlight 内部测试分发，操作见 docs/IOS_TESTFLIGHT.zh-CN.md。

只完成当前任务必要的构建、配置和启停，不另起开发或预览服务。
遵守仓库关于不自动运行或补写测试、不计算或比对哈希的约定，
不追加额外验收门禁。出现实际错误就处理该错误。
完成后说明修改、部署和各端产物的实际状态。
```

## 2. 当前部署目标

| 用途 | 位置 |
| --- | --- |
| 源码仓库 | `D:/Relay-Bot` |
| 后端程序安装 | `D:/Relay-Bot-app` |
| 正式业务数据 | `D:/Relay-Bot-data` |
| Windows 本机发行物 | `D:/Relay-Bot-data/client-releases` |
| 各平台远程发行物 | GitHub Releases：`buyun00/Summon-Bot` |
| 正式公网入口 | `https://bot.lin0.org` |
| 同一环境的本机入口 | `http://127.0.0.1:8787` |

- 运行需要 Node.js 24+，Windows 构建所用运行时须避开受 libuv TCP keepalive 缺陷影响的旧版本（详见 [运行维护 · 发行与升级](OPERATIONS.zh-CN.md#2-发行与升级)）。依赖由 `package-lock.json` 锁定，需要安装时在源码根目录运行 `npm ci`。
- 模型连接与用途路由表保存在数据根 `config/model-connections.json`，API Key 与独立订阅授权保存在 `config/model-credentials.json`，既有 `config/runtime.env` 凭据按显式变量名引用。本机 Codex / Grok 导入直接引用其登录文件，绝不将密钥写入聊天或代码。客户端签名与发布凭据沿用既有私有配置及当前应用 ID。
- 首次启动后可在网页设置中配置模型连接、用途路由表与执行连接，并创建群聊与 Bot。网页与 Tauri 桌面端共用正式页面；iOS 与 Android 为原生客户端，统一使用协议 3。

## 3. 按任务选择操作入口

以下命令均在 `D:/Relay-Bot` 下针对唯一正式安装执行。

### 仅启动或停止已有安装

启动：

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
```

正常停止：

```powershell
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
```

启动直接沿用已安装并选定的当前发行版本；源码修改需通过构建安装流程生效。

### 网页制作阶段

```powershell
npm run release:web
```

安装与现行协议兼容的工作区构建，由安装器自动完成有序排空、切换与启动。制作阶段的界面或逻辑改动在唯一正式网页生效，Tauri 桌面端刷新后同步呈现。

### 定稿后的完整发布

先按 [开发方式](DEVELOPMENT.zh-CN.md) 同步原生移动端与必要的桌面代码，按 [客户端发行与更新](CLIENT_RELEASES.zh-CN.md#2-版本递增与-windows-本地发布) 运行 `npm run release:version` 递增版本与构建号，提交并推送本次负责的文件。首次准备 Tauri 桌面依赖时运行：

```powershell
npm ci --prefix desktop-tauri --no-audit --no-fund
```

随后执行：

```powershell
npm run release:all
```

该入口从当前 Git 提交构建 Windows 本机包、正式网页与后端。同协议发布可直接更新 Web；若涉及协议升级，需等待同提交的 Windows 本机包、GitHub Releases 与 iOS TestFlight 内部版本就绪后再切换。发布流程先就位新产物，再更新最新版元数据并清理被替代产物，有效业务数据原样保留。

## 4. 延伸参考

- 首次安装、看门狗配置、排空续接与故障定位：[运行维护](OPERATIONS.zh-CN.md)
- 各端单独构建、GitHub Actions 与签名配置：[客户端发行与更新](CLIENT_RELEASES.zh-CN.md)
- 仅修改文档时直接交付，无需运行构建、部署或客户端打包命令。
