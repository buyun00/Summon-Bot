[English](DEVELOPMENT.md) | [简体中文](DEVELOPMENT.zh-CN.md)

# Development Conventions & Workflow

Repository-wide rules live in [AGENTS.md](../AGENTS.md); explicit follow-up user instructions always take precedence.

## 1. Naming & Identity Boundaries

- Display name: `Summon Bot`; GitHub repository: `Summon-Bot`; root npm package: `summon-bot`; workspace scope: `@summon/*`; npm command prefix: `summon:*`; code type prefix: `Summon`; environment variable prefix: `SUMMON_`.
- Existing source, installation, and data paths stay in place. Desktop and Android retain their existing app IDs and signing identities. iOS uses `ios/Summon.xcodeproj` with Bundle ID `org.lin0.summon` and production APNs push.
- Client upgrades perform one-time migrations of legacy local settings, credentials, and caches, removing legacy items after success without retaining dual compatibility paths.

## 2. Standard Development & Release Workflow

1. **Craft & iterate on Web first**: Build and visually debug new features on the Web client through the single formal entry. During crafting, uncommitted workspace edits may be deployed to the formal Web entry with `npm run release:web`; do not finalize commits or publish mobile/desktop installers prematurely.
2. **Sync native clients & desktop shell**: Once Web behavior, UX, and protocol are finalized, mirror them into native iOS (SwiftUI), native Android (Kotlin/Compose), and any required Tauri desktop code (`desktop-tauri/`). Web edits never auto-generate native mobile UIs.
3. **Commit & push a unified baseline**: Bump versions via `npm run release:version` when shipping client updates, then commit and push so every platform artifact builds from the same Git commit.
4. **Publish through platform channels**:
   - Windows desktop builds locally and publishes only to `D:/Relay-Bot-data/client-releases` (never uploaded from localhost to GitHub);
   - GitHub Releases for Windows, macOS (Apple Silicon `arm64` only, Developer ID signed & notarized), and Android are built and published by GitHub Actions from that commit;
   - iOS signs, archives, and uploads to TestFlight internal testing via GitHub Actions.
5. **Protocol upgrade ordering**: Whenever a change bumps the protocol version, ensure same-commit local Windows packages, GitHub Releases, and TestFlight builds are actually available before switching the formal Web/backend.

## 3. Four First-Party Clients & Update Channels

| Client | Implementation | Update Mechanism |
| --- | --- | --- |
| Web | Standard browser app (PWA retired) | Reload after deployment; legacy `/sw.js` only clears old offline caches and unregisters itself while keeping drafts and settings |
| Desktop (Windows / macOS) | Tauri (`desktop-tauri`) loading formal Web UI | Auto-checks and downloads in background; click "Install Update" in the avatar menu to stop local runtime, apply update (NSIS silent install on Windows / atomic DMG replace on macOS), and relaunch |
| Android | Native Kotlin / Jetpack Compose | Foreground check, background APK download, and one-click install from the avatar menu |
| iOS | Native SwiftUI (iOS 26+) | Installed and updated via TestFlight internal testing |

> Because Tauri Desktop loads the formal Web UI, Web changes deployed during crafting on the host machine also appear in Desktop on refresh.

## 4. Fixed Paths & Release Sources

| Purpose | Path / Source |
| --- | --- |
| Source Git repository | `D:/Relay-Bot` |
| Backend installation | `D:/Relay-Bot-app` |
| Formal business data | `D:/Relay-Bot-data` |
| Local Windows releases | `D:/Relay-Bot-data/client-releases` |
| Remote platform releases | GitHub Releases: `buyun00/Summon-Bot` |

Client downloads query `http://127.0.0.1:8787` first and fall back directly to GitHub Releases without proxying binaries through the formal server. Each target keeps only the current latest release; installers are never committed to Git or left in source `dist/`. See [Client Releases & Auto-Update](CLIENT_RELEASES.md).

## 5. Pure-Development Constraints & Delivery Discipline

- **Single formal environment**: Only `https://bot.lin0.org` (local `http://127.0.0.1:8787`) runs. Never spin up dev, test, or temporary preview servers or alternate data roots. Deliver source changes through the formal install pipeline in [Operations & Maintenance](OPERATIONS.md).
- **Latest-only hygiene**: Update all live references and clean superseded builds, configs, obsolete docs, and intermediate directories on delivery—no fallback copies or legacy compatibility branches. Data schema shifts migrate valid chats, memories, tool records, and user files once, then remove the migration code.
- **No unrequested test/hash overhead**: Unless explicitly requested by the user, do not run regression, unit, integration, browser, or live-model tests; do not write or restore tests; do not compute or compare file/directory/artifact hashes; and never gate delivery on extra verification reports.
- **Runtime & credentials**: Build and install with Node.js 24+. Reuse host private configs for model and signing credentials—never send test prompts to models or populate cleared user chat history just to inspect UI.
- **Direct error handling & truthful reporting**: Fix real build/runtime errors as they occur; report a blocker only when a concrete missing prerequisite prevents progress. Report truthfully what was changed, executed, and left pending.
