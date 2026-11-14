<div align="center">

<img src="web/frontend/icons/icon-512.png" alt="Summon Bot" width="104" />

# Summon Bot

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

Summon Bot lets people and persistent AI Bots collaborate in rooms, share files, and work with connected execution tools. Each Bot has its own model binding, instructions, private material and conversation history.

## Using Summon Bot

- Create a Bot, choose its model and instructions, then add it to a room.
- Send messages, attachments, replies and mentions. Room pins use the same message and file references.
- Configure model and execution connections in settings. Pi can use the configured Codex, CLI, MCP and HTTP connections within granted resources.
- Open execution sessions to inspect output, answer native requests, or stop an actual execution. Bot, conversation and session controls each retain their own state.
- Use ordinary files for notes and reusable Skills. An explicit material index selects what a Bot should consult or organize.

The web client and Electron share the same site. iOS and Android use native clients with the same protocol. [Client releases and updates](docs/CLIENT_RELEASES.md)

## Development and deployment

- [Architecture](docs/ARCHITECTURE.md)
- [Model and execution connections](docs/MODEL_CONNECTIONS.md)
- [Deployment](docs/DEPLOYMENT.md) and [operations](docs/OPERATIONS.md)
- [Development](docs/DEVELOPMENT.md)
