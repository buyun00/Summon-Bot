[English](OPERATIONS.md) | [简体中文](OPERATIONS.zh-CN.md)

# Operations & Maintenance

Summon Bot operates a single formal production environment: business data lives in `D:/Relay-Bot-data` and backend binaries live in `D:/Relay-Bot-app`. Public HTTPS (`https://bot.lin0.org`) and local loopback (`http://127.0.0.1:8787`) serve the same running instance and data.

## 1. Start, Stop, Status & Logs

```powershell
& D:/Relay-Bot-app/Start.ps1 -DataRoot D:/Relay-Bot-data
& D:/Relay-Bot-app/Stop.ps1 -DataRoot D:/Relay-Bot-data
npm run summon:status -- --data-root D:/Relay-Bot-data
```

- Windows launchers run the bundled Node executable from the active release. Double-clicking `Start-Hidden.vbs` or `Run.cmd` launches without a visible terminal window.
- The StartupHub `Summon Bot` scheduled task runs the watchdog through the same entrypoint, automatically recovering exited Web or gateway processes by service identity. Graceful stops persist desired state; user-paused Bots, conversations, and execution sessions remain paused across restarts.
- Local access is live as soon as the gateway and Web are ready. Web restores registered self-managed remote connectors (Tailscale / Cloudflare Tunnel) in the background and reports status via `summon:status`; remote connector failures never block local access.
- Configuration layout:
  - `config/deployment.json` (Schema v4, Data Format 3): active release root, listen address, `web.accessToken`, initial model settings, log rotation, and host resource limits.
  - `config/model-connections.json`, `config/model-credentials.json`, and `config/runtime.env`: model connections, purpose routing table, API keys, and env references. Day-to-day changes are managed from Web settings.
- Primary logs live under `web/logs/`, `web/watchdog/`, and `capabilities/gateway/logs/`. Rotation can be tuned via `logs.maxFileBytes`, `logs.maxFiles`, `logs.retentionDays`, and `logs.sweepIntervalMs` in `config/deployment.json` (with per-service overrides for Web and gateway). If managed log writes fail, services keep running and report the log error in `summon:status`.

## 2. Releases & Upgrades

After finalizing changes, syncing native clients, bumping `release.json`, and pushing, run `npm run release:all` to update the formal Web/backend and local Windows package (or `npm run release:web -- --committed-only` for backend/Web only). See [Client Releases & Auto-Update](CLIENT_RELEASES.md).

### Windows Node Runtime Requirement

Windows release builds must use a Node 24 LTS build that fixes the libuv Windows TCP keepalive native crash (`nodejs/node#62561`); `build.mjs` explicitly rejects `24.15.0` and `25.8.0`. Use Node 24.21.0 / 24.22.1 or newer LTS. If the system Node is an affected build, set `SUMMON_RELEASE_NODE` to a clean standalone Node executable or invoke `scripts/release/cli.mjs` directly with it.

### Graceful Drain & Installation State Machine

- Installation progress is persisted in `config/installation_state.json` across 6 exclusive phases: `prepared` → `draining` → `converting` → `data_ready` → `runtime_ready` → `done`.
- During an upgrade window, the installer verifies the running instance supports graceful drain (and verifies matching client releases when protocol version changes), closes autonomous intake, and waits for in-flight calls and writes to finish (default 3-minute timeout, adjustable via `--drain-timeout-ms`).
- If draining times out or is interrupted with Ctrl+C, re-running the same release command resumes the staged build; progress output and `summon:status` list blocking calls or services. To swap in a fixed candidate build, pass `--replace-pending`.
- Once the new release starts, superseded release directories and build staging folders are cleaned up automatically; any remaining cleanup errors surface in `cleanupPending` and finish on the next run. `D:/Relay-Bot-data/client-releases` is managed separately by client release scripts and is never cleared by backend cleanup.

## 3. Data Storage & Clearing Chat History

- **Shared records DB**: `capabilities/chatroom/state.sqlite` stores rooms, members, messages, attachments, execution sessions, and platform objects.
- **Per-Bot runtime DB**: `bots/<bot-id>/state.sqlite` stores each Bot's inbox, internal conversations, call receipts, and processing cursors.
- **Token ledger**: `usage.sqlite` tracks real model requests and purpose-level token accounting.
- **Clearing chat history**: Only when explicitly requested by the user, stop the formal instance gracefully and run:

```powershell
npm run summon:history -- --data-root D:/Relay-Bot-data
```

This acquires an exclusive write lock, clears message history, and advances `historyEpoch` while preserving Bots, user profiles, files, and usage history. On reconnect, clients see the new `historyEpoch`, clear stale chat caches automatically, and preserve unsent drafts.
