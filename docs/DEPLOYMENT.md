# 交给 AI 部署

这份文档面向操作仓库和本机环境的 AI 助手。先读取项目约定，再根据当前任务选择启动、网页制作或正式发布；配置与安装细节以 [运行维护](OPERATIONS.md) 和 [客户端发行与更新](CLIENT_RELEASES.md) 为准。

## 可以直接交给 AI 的指令

```text
请帮我部署或更新 Summon Bot。

先阅读 AGENTS.md、docs/DEVELOPMENT.md、docs/DEPLOYMENT.md、
docs/OPERATIONS.md 和 docs/CLIENT_RELEASES.md，再检查当前代码与已有安装。
只处理本次任务负责的文件，保留其他进行中的改动。

沿用仓库约定的唯一正式环境、安装目录和数据根，保留有效对话、
记忆、工具记录与用户文件。需要凭据时读取已有私有配置，
不要把凭据写进代码、聊天、日志或提交。

先在网页制作效果。网页定稿后同步原生手机端与必要的桌面代码，
提交并推送，再按现有流程部署和发布。制作阶段可以更新正式网页，
客户端安装包在定稿后发布；Windows 默认本地打包，macOS 和 Android 默认由 GitHub Actions 构建，iOS 使用 GitHub Actions 签名上传并通过 TestFlight 内部测试分发，操作见 docs/IOS_TESTFLIGHT.md。

只完成当前任务必要的构建、配置和启停，不另起开发或预览服务。
遵守仓库关于不自动运行或补写测试、不计算或比对哈希的约定，
不追加额外验收门禁。出现实际错误就处理该错误。
完成后说明修改、部署和各端产物的实际状态。
```

## 当前部署目标

| 用途 | 位置 |
| --- | --- |
| 源码 | D:/Relay-Bot |
| 后端安装 | D:/Relay-Bot-app |
| 业务数据 | D:/Relay-Bot-data |
| Windows 本机发行物 | D:/Relay-Bot-data/client-releases |
| 各平台远程发行物 | GitHub Releases：buyun00/Summon-Bot |
| 正式入口 | https://bot.lin0.org |
| 同一环境的本机入口 | http://127.0.0.1:8787 |

运行需要 Node.js 24+，Windows 打包所用运行时版本按 [运行维护中的发行说明](OPERATIONS.md#发行与升级) 选择。依赖由 package-lock.json 固定，需要安装时在源码根运行 npm ci。

模型连接由数据根的 config/model-connections.json 管理，API Key 和独立订阅授权保存到 config/model-credentials.json，已有 config/runtime.env 凭据仍按明确引用使用。本机 Codex / Grok 导入引用各自的登录文件，不将令牌写入聊天。客户端签名和发布凭据保存在既有私有配置中，保留当前应用 ID 与签名身份。

首次启动后可在网页设置中配置模型与执行连接，并创建 Bot 和聊天室。网页与 Electron 共用正式页面。Android 和 iOS 使用原生界面，并使用相同协议。

## 按任务选择入口

以下命令在 D:/Relay-Bot 执行，针对已有正式安装。

### 只启动或停止已有安装

启动：

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
```

正常停止：

```powershell
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
```

启动沿用安装选择的当前发行代码，源码编辑通过构建安装生效。

### 网页制作阶段

```powershell
npm run release:web
```

此入口安装与现行协议相容的工作区构建，由安装器完成收尾和启动。制作阶段的修改在唯一正式网页生效，Electron 刷新后也会显示。

### 定稿后的完整发布

先按 [开发流程](DEVELOPMENT.md) 同步原生端与必要的桌面代码，按 [版本说明](CLIENT_RELEASES.md#版本和-windows-发布) 更新发行版本和递增构建号，提交并推送本次负责的文件。需要准备桌面依赖时运行：

```powershell
npm ci --prefix desktop --ignore-scripts --no-audit --no-fund
```

再执行：

```powershell
npm run release:all
```

Windows 上的完整发布从 Git 当前提交构建本机包、网页和后端。同协议部署可先更新 Web。需要切换协议时，同提交的 Windows 本机包、GitHub 安装包和 iOS TestFlight 内部版本须先可取得。具体操作见 [客户端发行与更新](CLIENT_RELEASES.md)。

客户端下载先查设备本机，再直接从 GitHub 获取，远程安装包不再通过正式主机转发。发布流程先就位新产物，再切换最新版元数据，清理被替代的版本与中间目录，保留有效业务资料。

## 需要进一步处理时

- 完整安装、启停、模型配置与故障定位：[运行维护](OPERATIONS.md)。首次安装须使用其中的构建与安装入口，先生成安装目录再启动。
- 分别构建、上传或发布各端：[客户端发行与更新](CLIENT_RELEASES.md)。

只修改文档时直接交付文档，无需运行部署或客户端打包命令。
