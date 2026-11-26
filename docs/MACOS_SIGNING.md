[English](MACOS_SIGNING.md) | [简体中文](MACOS_SIGNING.zh-CN.md)

# macOS Developer ID Signing & Notarization

macOS Apple Silicon (`arm64`) DMGs published to GitHub Releases are signed with **Developer ID Application** + Hardened Runtime, submitted to Apple Notarization (`notarytool`), and stapled onto the `.app` bundle. Official releases abort if signing material is missing or notarization fails.

macOS distributes via GitHub Releases using the Tauri bundle identifier `org.lin0.relay.desktop.tauri` and display name `Summon Bot` (no Mac App Store record is required). Installed apps automatically download notarized updates in the background and apply them in-app from the avatar menu.

## 1. Issue the Developer ID Application Certificate

The CSR and private key are stored in the host private directory—upload only the CSR and keep the private key strictly local:
`C:\Users\win11\.codex\private\summon-macos-signing\Summon-Developer-ID.certSigningRequest`

1. Sign in as the Account Holder at [Apple Developer](https://developer.apple.com/account/) and select team `6Y29E7PSVF`.
2. Go to **Certificates, Identifiers & Profiles** → **Certificates** → **+**.
3. Choose **Developer ID Application** (and **G2 Sub-CA** if prompted for a Certificate Authority).
4. Upload the `.certSigningRequest` file above, click Continue, and download the generated `.cer` certificate (do not generate a new CSR or upload `.key`).

Reference: [Apple: Create Developer ID Certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).

## 2. Configure GitHub Secrets & Trigger Release

Run `scripts/macos/signing.py configure <path-to-cer>`. The script verifies certificate type, Team ID, expiration, and private key match, packages a PKCS#12 bundle with a random password, and writes these GitHub Secrets via stdin:

- `SUMMON_MACOS_P12_BASE64`
- `SUMMON_MACOS_P12_PASSWORD`

> When invoking Python from PowerShell, if child processes cannot read the Windows `gh` credential store, inject `gh auth token` into the child process `GH_TOKEN` environment variable temporarily and clear it afterward without printing the token.

Notarization reuses the repository's existing App Store Connect API credentials (`SUMMON_ASC_PRIVATE_KEY`, `SUMMON_ASC_KEY_ID`, `SUMMON_ASC_ISSUER_ID`), never the APNs key. Reference: [Apple TN3147: Migrating to the Latest Notarization Tool](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool).

Trigger a standalone macOS build and release (or let a `release.json` push build all platforms automatically):

```powershell
gh workflow run client-releases.yml --repo buyun00/Summon-Bot --ref main -f platform=macos-tauri
```

The GitHub macOS runner imports the signing certificate, builds the Apple Silicon `arm64` Tauri app, submits it for Apple notarization, staples the ticket, and publishes the DMG to the `client-macos-arm64-tauri` release tag.

## 3. Installation Behavior

- Newly signed and notarized DMGs open directly on macOS without Gatekeeper's "unverified developer" block (macOS may still display the standard "downloaded from the Internet" confirmation prompt).
- Previously downloaded unsigned DMGs do not inherit signing retroactively; download the latest notarized DMG and drag-replace the app.
