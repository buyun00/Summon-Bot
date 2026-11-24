[English](IOS_TESTFLIGHT.md) | [简体中文](IOS_TESTFLIGHT.zh-CN.md)

# Summon Bot: iOS Auto-Packaging, TestFlight & APNs Push Guide

Windows prepares the source tree and repository configuration; GitHub Actions macOS runners handle Xcode compilation, signing, archiving, upload, and distribution; iPhone and iPad devices install and update via TestFlight internal testing. No simulator, UI, or automated test gates block publishing.

## 1. Fixed Application Identifiers

| Field | Value |
| --- | --- |
| Display Name | `Summon Bot` |
| Apple Team ID | `6Y29E7PSVF` |
| Bundle ID | `org.lin0.summon` |
| App ID Description | `Summon Bot` |
| SKU | `summon-bot-ios` |
| Platform / Primary Language | iOS / Simplified Chinese |
| Capabilities | Push Notifications |
| Provisioning Profile Name | `Summon App Store` |
| Profile Type | App Store Connect (App Store) |
| Internal Testing Group | `Personal` inside the **Summon Bot** app record |
| Project / Scheme | `ios/Summon.xcodeproj` / `SummonBot` |
| Minimum OS | iOS / iPadOS 26 |

> Strictly use `org.lin0.summon`—never reuse legacy `org.lin0.relay` or another app's Bundle ID, Widget ID, or App Group. Desktop and Android retain their own existing signing identities.

## 2. New vs. Reused Signing Assets

| Asset | Handling |
| --- | --- |
| App ID | Register `org.lin0.summon` with Push Notifications enabled |
| Apple Distribution Certificate & Private Key | Reuse existing team signing certificate matching local `.p12` |
| App Store Provisioning Profile | Create specifically for `org.lin0.summon` with Push Notifications and the distribution cert above |
| App Store Connect App Record | Create a dedicated `Summon Bot` app record |
| App Store Connect API Key | Reuse existing team upload API Key with access to `Summon Bot` |
| APNs Key (`.p8`) | Separate from ASC API Key; must allow Production; deployed only on the formal backend |
| Internal Testing Group | Create `Personal` inside the `Summon Bot` app record |

Token-based APNs authentication (`.p8`) is used exclusively—no APNs SSL certificate, no iPhone UDID registration, and no Developer Mode requirement for TestFlight installs.

## 3. Register App ID & Enable Push Notifications

1. Sign in to [Apple Developer](https://developer.apple.com/account/) and select team `6Y29E7PSVF`.
2. Open **Certificates, Identifiers & Profiles** → **Identifiers** → **+**.
3. Choose **App IDs** → Continue → **App** → Continue.
4. Set Description to `Summon Bot`, select **Explicit** Bundle ID, and enter `org.lin0.summon`.
5. Enable **Push Notifications** under Capabilities (do not enable HealthKit, iCloud, App Groups, or Sign in with Apple).
6. Review and click **Register**, then reopen the identifier to confirm Push Notifications is active (skip SSL certificate creation).

Reference: [Apple: Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id/).

## 4. Create the App Store Connect App Record

1. Open [App Store Connect](https://appstoreconnect.apple.com/) → **Apps** → **+** → **New App**.
2. Choose **iOS**, Name **Summon Bot**, Primary Language **Simplified Chinese**, Bundle ID **org.lin0.summon**, and SKU **summon-bot-ios**.
3. Grant **Full Access** so existing team API credentials and internal testers can access the app, then click **Create**.
4. Internal TestFlight distribution does not require App Store review, store screenshots, or external Beta App Review.

Reference: [Apple: Add a New App](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/).

## 5. Generate the App Store Provisioning Profile

**Enable Push Notifications (Section 3) before generating the profile.**

1. Return to Developer → **Profiles** → **+**.
2. Under Distribution, choose **App Store Connect** (never Development, Ad Hoc, or Developer ID).
3. Select App ID `Summon Bot / org.lin0.summon` and the existing **Apple Distribution** certificate.
4. Name the profile **Summon App Store** → Generate → Download.
5. Save the file locally as:
   `C:\Users\win11\.codex\private\summon-ios-signing\app.mobileprovision`

Whenever app capabilities change, regenerate the profile and update the GitHub Secret. Reference: [Apple: Create an App Store Provisioning Profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile).

## 6. Create & Configure the Production APNs Key

1. Developer → **Keys** → **+**, name it **Summon APNs Production**.
2. Enable **Apple Push Notifications service (APNs)** and click Configure (if shown); ensure **Production** is permitted (TestFlight uses Production APNs, not Sandbox).
3. Register and download the `.p8` key (downloadable once), save it to `C:\Users\win11\.codex\private\summon-ios-signing\apns.p8`, and save the Key ID alone in `apns-key-id.txt` in the same folder.

> **Never mix keys**: Do not use an App Store Connect AuthKey `.p8` as the APNs key. The APNs private key stays strictly on the formal backend and is never uploaded to GitHub or bundled in the app.

Install the key into the formal data root (`config/apns.json` and `config/apns.p8`), then deploy/restart the formal gateway:

```powershell
$apnsKeyId = (Get-Content "$env:USERPROFILE/.codex/private/summon-ios-signing/apns-key-id.txt" -Raw).Trim()
node scripts/ios/configure-apns.mjs "$env:USERPROFILE/.codex/private/summon-ios-signing/apns.p8" $apnsKeyId
```

References: [Apple: Create a Private Key](https://developer.apple.com/help/account/keys/create-a-private-key/) · [Establishing a Token-Based Connection to APNs](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns).

## 7. Verify ASC API Key & Internal Testing Group

1. In App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**, verify the existing team API Key has upload, app access, and TestFlight management permissions (App Manager / Admin), and save its **Issuer ID** to `C:\Users\win11\.codex\private\summon-ios-signing\asc-issuer-id.txt`.
2. In App Store Connect → **Apps** → **Summon Bot** → **TestFlight**, create the internal group **Personal** and add your App Store Connect team testers (both automatic and scripted group distribution are supported).

Reference: [Apple: Add Internal Testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).

## 8. Sync GitHub Configuration & Run Release

Once all files are in place, run from the repository root (requires authenticated `gh`, Python, `cryptography`, and `PyJWT`; pass `-ApiKeyFile` if multiple ASC keys exist locally):

```powershell
pwsh -NoProfile -File scripts/ios/configure-github.ps1
gh workflow run ios-testflight.yml --repo buyun00/Summon-Bot --ref main -f action=release
```

| GitHub Setting | Purpose |
| --- | --- |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_BASE64` | Team distribution certificate & private key |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_PASSWORD` | Export password for the `.p12` |
| Secret `SUMMON_IOS_APP_PROFILE_BASE64` | Provisioning profile for `org.lin0.summon` |
| Secrets `SUMMON_ASC_KEY_ID`, `SUMMON_ASC_ISSUER_ID`, `SUMMON_ASC_PRIVATE_KEY` | App Store Connect upload & distribution credentials |
| Variable `SUMMON_APPLE_TEAM_ID` | `6Y29E7PSVF` |
| Variable `SUMMON_TESTFLIGHT_GROUP` | `Personal` |
| Variable `SUMMON_IOS_RELEASE_ENABLED` | Set to `true` once all assets are verified |

- With `SUMMON_IOS_RELEASE_ENABLED=true`, changes to `release.json` on `main` automatically trigger TestFlight release; pass `action=compile` for an unsigned compilation check.
- CI build numbers follow `<buildNumber>.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>` (for example, `172.12.1`). Always check the Actions summary for the exact TestFlight version and full build number.
- Pipeline steps: config validation → Xcode archive → signed export → API upload → Apple processing → exact version/build verification → internal group assignment → `IN_BETA_TESTING` readback.
- If Apple processing exceeds 30 minutes, resume distribution with the uploaded version and full build number from the summary:

```powershell
gh workflow run ios-testflight.yml --repo buyun00/Summon-Bot --ref main -f action=resume -f version=VERSION -f build_number=APPLE_BUILD
```

## 9. Install on iPhone & Verify Push Notifications

1. Ensure the iPhone runs iOS 26+ with **TestFlight** installed, and accept the internal tester invite with the matching Apple Account.
2. Open **Summon Bot** in TestFlight, confirm the version and full build number match the Actions summary, and tap Install.
3. Launch the app, enter the formal URL (`https://bot.lin0.org`) and access token, allow notifications when prompted, and verify **Settings → Notifications** shows push enabled.
4. Push banners hide private message bodies by default (displaying a generic new-message notice and loading content once opened) and notify only for Bot messages in rooms the user participates in. Background SSE keepalive is unnecessary.

## 10. Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Bundle ID missing when creating app | Verify team `6Y29E7PSVF` and confirm `org.lin0.summon` is registered |
| Profile missing `aps-environment` | Enable Push Notifications on the App ID, regenerate the profile, and update the Secret |
| Certificate / profile mismatch | Regenerate the profile using the existing Apple Distribution certificate |
| Actions release job skipped | Verify repository Variable `SUMMON_IOS_RELEASE_ENABLED` is `true` |
| ASC API 401 / 403 | Check Key ID, Issuer ID, permissions, and ensure the APNs `.p8` wasn't used |
| Build not visible in TestFlight | Verify `Personal` group inside `Summon Bot`, tester invite acceptance, and full build number |
| iPhone reports incompatible OS | Minimum deployment target is iOS / iPadOS 26 |
| Server push unconfigured / APNs 403 | Run `configure-apns.mjs`, restart the formal gateway, and verify Production env, Team ID, topic scope, and host clock |

The server persists the APNs push queue, retries transient failures automatically, purges invalid device tokens, and retains pending notifications for up to 24 hours.
