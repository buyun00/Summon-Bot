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
客户端安装包在定稿后发布；Windows 默认本地打包，macOS 和 Android 默认由 GitHub Actions 构建，iOS 暂不打包发布。

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

首次安装并启动后，打开网页会先进入与主 Bot 的入门对话。模型尚未配置时，介绍和选项由本地消息呈现：先查运行 Summon Bot 的主机上是否存在可导入的 Codex / Grok 登录，用户选择后才导入；没有可用登录时引导填写 API Key，也支持订阅设备码授权。检测不扫描远程网页访问者或手机上的文件，不读取浏览器 Cookie。API Key 使用隐藏输入，不进入消息、草稿或本地对话缓存。保存在系统凭据存储而非登录文件中的账号，可选择订阅授权。

模型配置保存后，用户点击继续才发起第一条真实模型对话，由主 Bot 结合用户目标逐步介绍伙伴、工作、记忆和需要的后续配置。已有模型配置的安装不会被强制重新引导；“设置 → 新手引导”可以随时重新进入。网页与 Electron 直接显示同一网页；Android 和 iOS 使用原生对话界面，通过同一组模型接口接入主 Bot。脚本化入门回复不调用模型，不保存为真实聊天记录。

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

此入口构建当前工作区，正常停止既有服务与桌面连接器，安装后恢复运行。制作阶段的修改会出现在唯一正式网页，Electron 刷新时也会显示；本命令只更新网页和后端。执行前确认工作区内容属于当前获授权的交付范围。

### 定稿后的完整发布

先按 [开发流程](DEVELOPMENT.md) 同步原生端与必要的桌面代码，按 [版本说明](CLIENT_RELEASES.md#版本和-windows-发布) 更新发行版本和递增构建号，提交并推送本次负责的文件。需要准备桌面依赖时运行：

```powershell
npm install --prefix desktop --no-audit --no-fund
```

再执行：

```powershell
npm run release:all
```

Windows 上的完整发布从 Git 当前提交构建网页与后端，安装后只构建 Windows 桌面端，并同步本机发行目录和 GitHub Releases。macOS 和 Android 默认由 GitHub Actions 构建发布，macOS 使用无需开发者证书的 ad-hoc 签名，iOS 暂不打包发布。具体操作见 [客户端发行与更新](CLIENT_RELEASES.md)。

客户端下载先查设备本机，再直接从 GitHub 获取，远程安装包不再通过正式主机转发。发布流程先就位新产物，再切换最新版元数据，清理被替代的版本与中间目录，保留有效业务资料。

## 需要进一步处理时

- 完整安装、启停、模型配置与故障定位：[运行维护](OPERATIONS.md)。首次安装须使用其中的构建与安装入口，先生成安装目录再启动。
- 单独更新某项领域能力：[能力服务与热更新](CAPABILITY_SERVICES.md)。
- 分别构建、上传或发布各端：[客户端发行与更新](CLIENT_RELEASES.md)。

只修改文档时直接交付文档，无需运行部署或客户端打包命令。
