# Relay Bot

每个 Bot 都是独立运行的 Pi Agent。Bot 本体在一级 `bot/` 中，包名为 `@relay/bot`；聊天室、文件操作、Codex、分身创建和记忆合并通过外部能力提供。Web 仅负责页面和 API 转发。

## 工程

- `bot/`：可单独安装的 Bot 包，生命周期、任务/消息、上下文、持久化、工具/MCP/Skill 接入。
- `capabilities/`：六类独立 MCP/API 服务，以及注册、版本绑定和协商热更网关。
- `roles/`：角色配置与提示词；`skills/`：可加载流程说明。
- `web/`：前端与轻量网关；`scripts/`：构建、安装、迁移。

## 开发与运行

需要 Node.js 24 或更新版本。依赖版本由 package-lock.json 固定。

按 [AGENTS.md](AGENTS.md) 和 [DEVELOPMENT.md](docs/DEVELOPMENT.md) 开发：完成必要修改后直接交付或按授权运行。用户未另行明确要求时，不自动运行或补写测试，不做哈希计算或比对，不追加重复验收，也不将额外回执或流程报告设为交付门禁。

```powershell
npm ci
npm run relay:dev -- --data-root D:\Relay-Bot-dev-data
```

先在数据根的 `config/runtime.env` 中配置模型凭据。开发数据与真实部署数据分开。

## 构建与安装

```powershell
npm run relay:pack
npm run relay:install -- --release-root <构建输出路径> --app-root D:\Relay-Bot-app --data-root D:\Relay-Bot-data --public-origin https://bot.lin0.org
& D:\Relay-Bot-app\Start.ps1
& D:\Relay-Bot-app\Stop.ps1
```

发行物带 Node 运行时和生产依赖，可从不同 cwd 启动，无开发目录链接。完整基础程序安装前正常停止服务和 Bot；独立能力发布支持新旧版本并存，在 Bot 准备好后切换，见 [能力服务与热更新](docs/CAPABILITY_SERVICES.md)。操作说明见 [OPERATIONS](docs/OPERATIONS.md)，设计见 [ARCHITECTURE](docs/ARCHITECTURE.md)，完整重构依据见 [REFACTOR_PLAN](docs/REFACTOR_PLAN.md)。此前验证事实保留在 [VERIFICATION](docs/VERIFICATION.md)，不构成后续开发的测试或验收要求。
