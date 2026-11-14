<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="104" />

# Summon Bot

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

Summon Bot 让用户与持续存在的 Bot 在群里交流、共享资料和调用执行工具。每个 Bot 有自己的模型配置、行为指令、私有资料和对话记录。

## 使用 Summon Bot

- 创建 Bot，选择模型、填写行为指令，再将它加入群聊。
- 发送消息、附件、回复和 @。群置顶沿用消息和文件的实际引用。
- 在设置中配置模型与执行连接。Pi 可以在授权范围内调用已配置的 Codex、CLI、MCP 和 HTTP。
- 在执行会话查看输出、回答原生请求及停止执行。Bot、内部对话和执行会话分别保存自己的控制状态。
- 用普通文件保存笔记和可复用的 Skill。通过显式索引选择 Bot 应读取或整理的资料。

网页与 Electron 共用正式网页。iOS 和 Android 使用同一协议的原生界面。[客户端发行与更新](docs/CLIENT_RELEASES.md)

## 开发与部署

- [架构](docs/ARCHITECTURE.md)
- [模型与执行连接](docs/MODEL_CONNECTIONS.md)
- [部署](docs/DEPLOYMENT.md)与[运行维护](docs/OPERATIONS.md)
- [开发方式](docs/DEVELOPMENT.md)
