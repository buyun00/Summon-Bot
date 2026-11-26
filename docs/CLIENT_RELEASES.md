[English](CLIENT_RELEASES.md) | [简体中文](CLIENT_RELEASES.zh-CN.md)

# Client Releases & Auto-Update

Summon Bot ships four first-party clients: standard Web, Windows / macOS (Apple Silicon) Tauri Desktop, native Kotlin / Compose Android, and native SwiftUI iOS 26. Web and Tauri Desktop share the same production Web UI.

Once Web changes are finalized, synced to native clients, committed, and pushed:
- **Windows**: Packaged locally on Windows and published only to the local release directory (never uploaded from the local machine to GitHub).
- **GitHub Releases (Windows / macOS / Android)**: Built and published exclusively by GitHub Actions from the same commit.
- **iOS**: Signed, archived, uploaded, and distributed to the TestFlight internal group by GitHub Actions; see [iOS Auto-Packaging, TestFlight & APNs Guide](IOS_TESTFLIGHT.md).

## 1. Download & Update Source Order

Windows x64 ships a Tauri NSIS EXE installer, Apple Silicon macOS ships a signed/notarized Tauri `arm64` DMG, and Android ships a universal APK. Native iOS and Android prompt for the instance URL and access token on first launch.

Every client checks and downloads updates in strict fallback order:

1. **Local device first**: Queries `http://127.0.0.1:8787`. Local artifacts live under `D:/Relay-Bot-data/client-releases/<platform>/<arch>`. When a valid artifact matching or exceeding the current formal build number exists locally, it is preferred without hitting remote GitHub endpoints for that target.
2. **Direct GitHub Releases fallback**: When localhost is unavailable, lacks a valid artifact, or a local Windows/Android download fails, the client fetches directly from the public [buyun00/Summon-Bot Releases](https://github.com/buyun00/Summon-Bot/releases)—never proxied through the formal host and never reading the source tree.

The Web "Client Downloads & Updates" panel uses the same lookup order. Remote `GET /api/releases` returns only the GitHub catalog and direct links; the local endpoint reads local artifacts (`?local=1` checks localhost only without contacting GitHub). When browser policies block localhost access, it falls back seamlessly to GitHub.

GitHub Releases maintain 3 rolling tags:
- `client-windows-x64-tauri`
- `client-macos-arm64-tauri`
- `client-android-universal`

Each tag retains only the latest installer and `latest.json` update metadata. Publishing uploads the new binary first, updates metadata next, and deletes superseded assets last.

## 2. Versioning & Local Windows Release

All platforms read `version`, monotonic `buildNumber`, `appUrl`, and `githubRepository` from root `release.json`. Bump the version before each release:

```powershell
npm run release:version
```

This synchronizes workspace `package.json`, lockfiles, and the Xcode project version (Android reads `release.json` directly). After committing and pushing, run from the repository root:

```powershell
npm run release:all
```

This builds the local Windows package plus the formal Web and backend from the current Git commit:
- **Same-protocol releases**: Update Web/backend immediately while clients roll out via their respective channels.
- **Protocol-changing releases**: Stage the local Windows package first, then verify that same-commit GitHub Releases and TestFlight internal builds are actually available before switching the formal server (querying App Store Connect directly when configured, or reading the same-commit Actions result).
- For initial Tauri desktop dependency installation, run `npm ci --prefix desktop-tauri --no-audit --no-fund`.

You can also invoke individual release commands:

```powershell
npm run release:desktop:tauri
npm run release:web -- --committed-only
```

- During active Web crafting, `npm run release:web` installs a protocol-compatible workspace build to the single formal Web entry so changes can be inspected live.
- On Windows, `release:desktop:tauri` publishes only to the local release directory by default (`--publish` is also local-only; `--github` is reserved for GitHub Actions).

## 3. GitHub Actions Workflows

The [Client releases workflow](../.github/workflows/client-releases.yml) triggers automatically on `main` when `release.json` changes, or manually for `cloud`, `windows-tauri`, `macos-tauri`, or `android`. It installs dependencies, builds, and publishes without running tests or spawning preview servers.

- **Windows (x64 Tauri)**: Built on a GitHub Windows runner with Rust + Tauri NSIS and published to `client-windows-x64-tauri`.
- **macOS (Apple Silicon `arm64` Tauri)**: Built on a GitHub macOS runner as an `arm64` DMG signed with Developer ID Application + Hardened Runtime, notarized by Apple, stapled, and published to `client-macos-arm64-tauri`. See [macOS Signing & Notarization](MACOS_SIGNING.md).
- **Android**: Built on a Linux runner with Java 17 and the repository Gradle wrapper using the existing signing identity supplied via GitHub Actions Secrets (original keystore stays only in host private config):
  - `SUMMON_ANDROID_KEYSTORE_BASE64`
  - `SUMMON_ANDROID_KEY_ALIAS`
  - `SUMMON_ANDROID_STORE_PASSWORD`
  - `SUMMON_ANDROID_KEY_PASSWORD`
- **iOS**: Signed, archived, and uploaded to TestFlight via [ios-testflight.yml](../.github/workflows/ios-testflight.yml) on `release.json` changes or manual dispatch.

## 4. Per-Platform Update Experience

- **Windows Tauri Desktop**: Installs per-user via NSIS EXE. Automatically checks for updates on startup and periodically (1.2 s local probe before falling back to GitHub Releases) and downloads in the background; once ready, an indicator dot appears on the bottom-left avatar and clicking **Install Update** in the avatar popup menu stops any self-managed local runtime, silently installs, and restarts automatically.
- **macOS Tauri Desktop**: Automatically checks and downloads the notarized `arm64` DMG in the background; clicking **Install Update** in the avatar popup menu stops any self-managed local runtime, silently mounts the DMG, atomically replaces the `.app`, and relaunches (falling back to opening the downloaded DMG if the install directory is read-only).
- **Android**: Checks for updates on foreground resume, automatically downloads newer APKs in the background, shows an indicator dot on the avatar with an **Install Update** entry in the avatar menu, and hands installation to the Android package installer.
- **iOS**: Installed and updated through TestFlight internal testing; see [iOS Auto-Packaging, TestFlight & APNs Guide](IOS_TESTFLIGHT.md).

## 5. Production Boundaries & PWA Retirement

- The backend runs exclusively from `D:/Relay-Bot-app` against `D:/Relay-Bot-data` on the fixed formal ports and URLs. Source `dist/` is strictly a backend build staging area; `D:/Relay-Bot-data/client-releases` is never wiped by backend cleanup and keeps only the current artifact per target.
- The Web app no longer registers a PWA or offline cache. Legacy `/sw.js` exists solely to clear old offline page caches and unregister itself while preserving user drafts and connection settings.
