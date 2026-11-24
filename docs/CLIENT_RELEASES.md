[English](CLIENT_RELEASES.md) | [简体中文](CLIENT_RELEASES.zh-CN.md)

# Client Releases & Auto-Update

Summon Bot ships four first-party clients: standard Web, Windows / macOS (Apple Silicon) Electron Desktop, native Kotlin / Compose Android, and native SwiftUI iOS 26. Web and Electron Desktop share the same production Web UI.

Once Web changes are finalized, synced to native clients, committed, and pushed:
- **Windows**: Packaged locally on Windows and published only to the local release directory (never uploaded from the local machine to GitHub).
- **GitHub Releases (Windows / macOS / Android)**: Built and published exclusively by GitHub Actions from the same commit.
- **iOS**: Signed, archived, uploaded, and distributed to the TestFlight internal group by GitHub Actions; see [iOS Auto-Packaging, TestFlight & APNs Guide](IOS_TESTFLIGHT.md).

## 1. Download & Update Source Order

Windows x64 ships an EXE installer, Apple Silicon macOS ships an `arm64` DMG, and Android ships a universal APK. Native iOS and Android prompt for the instance URL and access token on first launch; desktop CLI commands and candidate builds are covered in [Desktop README](../desktop/README.md).

Every client checks and downloads updates in strict fallback order:

1. **Local device first**: Queries `http://127.0.0.1:8787`. Local artifacts live under `D:/Relay-Bot-data/client-releases/<platform>/<arch>`. When a valid artifact matching or exceeding the current formal build number exists locally, it is preferred without hitting remote GitHub endpoints for that target.
2. **Direct GitHub Releases fallback**: When localhost is unavailable, lacks a valid artifact, or a local Windows/Android download fails, the client fetches directly from the public [buyun00/Summon-Bot Releases](https://github.com/buyun00/Summon-Bot/releases)—never proxied through the formal host and never reading the source tree.

The Web "Client Downloads & Updates" panel uses the same lookup order. Remote `GET /api/releases` returns only the GitHub catalog and direct links; the local endpoint reads local artifacts (`?local=1` checks localhost only without contacting GitHub). When browser policies block localhost access, it falls back seamlessly to GitHub.

GitHub Releases maintain 3 rolling tags:
- `client-windows-x64`
- `client-macos-arm64`
- `client-android-universal`

Each tag retains only the latest installer and metadata (`latest.json` for native clients, plus `latest.yml` on Windows for Electron auto-updater). Publishing uploads the new binary first, updates metadata next, and deletes superseded assets last.

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
- For initial desktop dependency installation, run `npm ci --prefix desktop --ignore-scripts --no-audit --no-fund`.

You can also invoke individual release commands:

```powershell
npm run release:desktop
npm run release:web -- --committed-only
```

- During active Web crafting, `npm run release:web` installs a protocol-compatible workspace build to the single formal Web entry so changes can be inspected live.
- On Windows, `release:desktop` publishes only to the local release directory by default (`--publish` is also local-only; `--github` is reserved for GitHub Actions). Re-running `release:all` reuses an already staged same-commit Windows package.
- If Electron runtime downloads face network constraints, set `SUMMON_ELECTRON_DIST` to the absolute path of the matching Electron ZIP archive.

## 3. GitHub Actions Workflows

The [Client releases workflow](../.github/workflows/client-releases.yml) triggers automatically on `main` when `release.json` changes, or manually for `cloud`, `windows`, `macos`, or `android`. It installs dependencies, builds, and publishes without running tests or spawning preview servers.

- **macOS (Apple Silicon `arm64`)**: Built on a GitHub macOS runner as an `arm64` DMG signed with Developer ID Application + Hardened Runtime, notarized by Apple, and stapled. See [macOS Signing & Notarization](MACOS_SIGNING.md).
- **Android**: Built on a Linux runner with Java 17 and the repository Gradle wrapper using the existing signing identity supplied via GitHub Actions Secrets (original keystore stays only in host private config):
  - `SUMMON_ANDROID_KEYSTORE_BASE64`
  - `SUMMON_ANDROID_KEY_ALIAS`
  - `SUMMON_ANDROID_STORE_PASSWORD`
  - `SUMMON_ANDROID_KEY_PASSWORD`
- **iOS**: Signed, archived, and uploaded to TestFlight via [ios-testflight.yml](../.github/workflows/ios-testflight.yml) on `release.json` changes or manual dispatch.

## 4. Per-Platform Update Experience

- **Windows Desktop**: Installs per-user via EXE. On first launch, choose the local formal instance or enter a remote URL and access token. Updates check automatically at startup and runtime (1.2 s local probe timeout before falling back to GitHub); click "Restart & Update" once downloaded.
- **macOS Desktop**: Web UI updates on page refresh; shell updates prompt the user to download the notarized DMG and drag-replace the app.
- **Android**: Checks for updates on foreground resume, reuses any already-cached matching APK, and hands installation to the Android package installer (requiring "Install unknown apps" permission on first install).
- **iOS**: Installed and updated through TestFlight internal testing; see [iOS Auto-Packaging, TestFlight & APNs Guide](IOS_TESTFLIGHT.md).

## 5. Production Boundaries & PWA Retirement

- The backend runs exclusively from `D:/Relay-Bot-app` against `D:/Relay-Bot-data` on the fixed formal ports and URLs. Source `dist/` is strictly a backend build staging area; `D:/Relay-Bot-data/client-releases` is never wiped by backend cleanup and keeps only the current artifact per target.
- The Web app no longer registers a PWA or offline cache. Legacy `/sw.js` exists solely to clear old offline page caches and unregister itself while preserving user drafts and connection settings.
