[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

# AI-Assisted Deployment Guide

This guide is written for AI coding assistants operating on the repository and host machine. Review repository conventions first, then pick the matching entrypoint for start/stop, Web crafting, or full release. Refer to [Operations & Maintenance](OPERATIONS.md) and [Client Releases & Auto-Update](CLIENT_RELEASES.md) for installation and packaging details.

## 1. Ready-to-Use Prompt for AI Assistants

```text
Please deploy or update Summon Bot.

Read AGENTS.md, docs/DEVELOPMENT.md, docs/DEPLOYMENT.md,
docs/OPERATIONS.md, and docs/CLIENT_RELEASES.md first, then inspect the current source tree and existing installation.
Only touch files owned by this task and preserve any other in-progress work.

Keep the repository's single formal environment, install root, and data root, preserving valid chats,
memories, tool records, and user files. Read existing private configs whenever credentials are needed—
never write secrets into source code, chat replies, logs, or commits.

Craft and iterate in Web first. Once finalized, sync native mobile clients and any required desktop changes,
commit and push, then deploy and release via the established pipeline. Workspace builds may update the
single formal Web entry during crafting; client installers are published only after finalization.
Windows packages locally to the local release folder; macOS and Android build on GitHub Actions;
iOS signs and uploads to TestFlight internal testing via GitHub Actions (see docs/IOS_TESTFLIGHT.md).

Perform only the builds, configuration, and restarts strictly required by this task—never start separate
dev or preview servers. Respect repository rules against running/writing tests or computing hashes unless
explicitly requested. Fix real errors directly and report exact modified files, deployment status, and artifacts.
```

## 2. Deployment Targets

| Purpose | Location |
| --- | --- |
| Source repository | `D:/Relay-Bot` |
| Backend installation | `D:/Relay-Bot-app` |
| Formal business data | `D:/Relay-Bot-data` |
| Local Windows releases | `D:/Relay-Bot-data/client-releases` |
| Remote client releases | GitHub Releases: `buyun00/Summon-Bot` |
| Public production URL | `https://bot.lin0.org` |
| Local loopback URL | `http://127.0.0.1:8787` |

- Requires Node.js 24+; Windows builds must avoid Node builds affected by the Windows libuv TCP keepalive bug (see [Operations · Releases & Upgrades](OPERATIONS.md#2-releases--upgrades)). Dependencies are pinned by `package-lock.json` (`npm ci` from the repo root when needed).
- Model connections and purpose routing tables live in `config/model-connections.json`, API keys and standalone subscription credentials live in `config/model-credentials.json`, and existing `config/runtime.env` entries are referenced explicitly by variable name. Local Codex/Grok imports reference their auth files directly without copying secrets into chat or source. Client signing credentials stay in existing host private configs and preserve existing app IDs.
- After first startup, configure model connections, purpose tables, execution connections, Bots, and rooms in Web settings. Web and Tauri Desktop share the formal UI; iOS and Android are native Protocol 3 clients.

## 3. Task Entrypoints

Run the following commands from `D:/Relay-Bot` against the single formal installation.

### Start or Stop the Existing Installation

Start:

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
```

Graceful stop:

```powershell
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
```

Startup launches the currently selected installed release; source changes take effect only through the build-and-install pipeline.

### Web Crafting Stage

```powershell
npm run release:web
```

Installs a protocol-compatible workspace build via the formal installer (including graceful drain, cutover, and restart). Changes take effect immediately on the single formal Web entry and appear in Tauri Desktop on refresh.

### Full Release After Finalization

Sync native mobile clients and desktop code per [Development Conventions](DEVELOPMENT.md), bump version and build number with `npm run release:version` per [Client Releases](CLIENT_RELEASES.md#2-versioning--local-windows-release), and commit and push your changes. If Tauri desktop dependencies need initial setup:

```powershell
npm ci --prefix desktop-tauri --no-audit --no-fund
```

Then run:

```powershell
npm run release:all
```

This builds the local Windows package, Web UI, and backend from the current Git commit. Same-protocol releases update Web immediately; protocol upgrades wait until same-commit Windows local packages, GitHub Releases, and iOS TestFlight internal builds are available. The pipeline stages new outputs first, updates metadata, and cleans superseded releases while keeping all valid data intact.

## 4. Further Reading

- First-time installation, watchdog setup, drain resumption, and diagnostics: [Operations & Maintenance](OPERATIONS.md)
- Individual platform builds, GitHub Actions, and signing: [Client Releases & Auto-Update](CLIENT_RELEASES.md)
- Documentation-only changes are delivered directly without running build, deployment, or packaging commands.
