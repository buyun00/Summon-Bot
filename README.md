# Relay Bot

每个 Bot 保留 PiAgent 内核，并拥有多个隔离的 chat/work 对话。默认 4 个业务执行位与 1 个维护位；同一逻辑对话串行，外部等待释放执行位。S1 原始记录与 S3 工作状态保存在 Bot SQLite，S2 总结只保存在按工作/对话隔离的 Markdown。压缩、整理、组装各自在需要时创建短暂维护对话，真实工作中的可复用经验可更新 Bot 自己的 Skill。

聊天室、文件操作、桌面 Codex 与既有持续职责沿用当前能力网关。普通任务创建 work；独立长期职责才使用独立 Bot。工作、外部绑定、待通知和停止状态跨重启保留；网页展示真实工作状态。实现说明见 [3+3 设计](docs/BOT_3_PLUS_3_DESIGN.md)。

## 工程

- `bot/`：可单独安装的 Bot 包，生命周期、任务/消息、上下文、持久化、工具/MCP/Skill 接入。
- `capabilities/`：六类独立 MCP/API 服务，以及注册、版本绑定和协商热更网关。
- `roles/`：角色配置与提示词；`skills/`：可加载流程说明。
- `web/`：前端与轻量网关；`scripts/`：构建、安装、维护。
- `ios/`：Swift / SwiftUI 原生 iPhone、iPad 客户端；Mac 直接打开 `ios/Relay.xcodeproj`，详见 [iOS 运行说明](ios/README.md)。

## 开发与运行

需要 Node.js 24 或更新版本。依赖版本由 package-lock.json 固定。

按 [AGENTS.md](AGENTS.md) 和 [DEVELOPMENT.md](docs/DEVELOPMENT.md) 开发：完成必要修改后直接交付或按授权运行。用户未另行明确要求时，不自动运行或补写测试，不做哈希计算或比对，不追加重复验收，也不将额外回执或流程报告设为交付门禁。

```powershell
npm ci
& D:\Relay-Bot-app\Start.ps1 -DataRoot D:\Relay-Bot-data
```

模型凭据位于正式数据根的 `config/runtime.env`。开发阶段也只使用这一套正式环境；每次更新替换为最新版并清理旧发行、旧能力配置和中间目录，不保留旧版兼容入口。

## 构建与安装

```powershell
npm run relay:pack
npm run relay:install -- --release-root <构建输出路径> --app-root D:\Relay-Bot-app --data-root D:\Relay-Bot-data --source-root D:\Relay-Bot --public-origin https://bot.lin0.org
& "$env:SystemRoot\System32\wscript.exe" //B //NoLogo D:\Relay-Bot-app\Start-Hidden.vbs
& D:\Relay-Bot-app\Stop.ps1
```

发行物带 Node 运行时和生产依赖，可从不同 cwd 启动，无开发目录链接。完整基础程序安装前正常停止服务和 Bot；独立能力发布在所有活动对话到达安全边界后切换，随后清理被替代版本，见 [能力服务与热更新](docs/CAPABILITY_SERVICES.md)。操作说明见 [OPERATIONS](docs/OPERATIONS.md)，设计见 [ARCHITECTURE](docs/ARCHITECTURE.md)，完整重构依据见 [REFACTOR_PLAN](docs/REFACTOR_PLAN.md)。此前验证事实保留在 [VERIFICATION](docs/VERIFICATION.md)，不构成后续开发的测试或验收要求。
