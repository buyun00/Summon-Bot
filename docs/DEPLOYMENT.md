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
客户端安装包在定稿后发布；macOS/iOS 从同一提交交给 Mac 打包。

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
| 客户端发行物 | D:/Relay-Bot-data/client-releases |
| 正式入口 | https://bot.lin0.org |
| 同一环境的本机入口 | http://127.0.0.1:8787 |

运行需要 Node.js 24+，Windows 打包所用运行时版本按 [运行维护中的发行说明](OPERATIONS.md#发行与升级) 选择。依赖由 package-lock.json 固定，需要安装时在源码根运行 npm ci。

模型配置由数据根的 config/deployment.json 管理，凭据沿用 config/runtime.env。客户端签名和发布凭据也保存在既有私有配置中，保留当前应用 ID 与签名身份。

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

Windows 上的完整发布从 Git 当前提交构建网页与后端，安装后构建并发布 Windows 桌面端和 Android APK。macOS/iOS 由 Mac 检出同一提交，按 [客户端发行与更新](CLIENT_RELEASES.md) 打包；尚未取得的产物如实列为待打包或待发布。

客户端产物使用现有正式 Web 服务分发。发布流程先就位新产物，再切换最新版元数据，清理被替代的版本与中间目录，保留有效业务资料。

## 需要进一步处理时

- 完整安装、启停、模型配置与故障定位：[运行维护](OPERATIONS.md)。首次安装须使用其中的构建与安装入口，先生成安装目录再启动。
- 单独更新某项领域能力：[能力服务与热更新](CAPABILITY_SERVICES.md)。
- 分别构建、上传或发布各端：[客户端发行与更新](CLIENT_RELEASES.md)。

只修改文档时直接交付文档，无需运行部署或客户端打包命令。
