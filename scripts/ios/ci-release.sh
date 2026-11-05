#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
export SIGNING_DIR="$RUNNER_TEMP/summon-signing"
mkdir -p "$SIGNING_DIR" "$HOME/Library/MobileDevice/Provisioning Profiles"
python3 - <<'PY'
import base64, os, pathlib, re
root = pathlib.Path(os.environ['SIGNING_DIR'])
for name, filename in [('SUMMON_IOS_DISTRIBUTION_P12_BASE64', 'distribution.p12'),
                       ('SUMMON_IOS_APP_PROFILE_BASE64', 'app.mobileprovision')]:
    try:
        root.joinpath(filename).write_bytes(base64.b64decode(''.join(os.environ[name].split()), validate=True))
    except Exception:
        raise SystemExit('Invalid signing secret: ' + name)
if not re.fullmatch(r'[A-Z0-9]{10}', os.environ['ASC_KEY_ID']):
    raise SystemExit('Invalid API key ID')
root.joinpath('AuthKey_' + os.environ['ASC_KEY_ID'] + '.p8').write_text(os.environ['ASC_PRIVATE_KEY'])
PY
security cms -D -i "$SIGNING_DIR/app.mobileprovision" > "$SIGNING_DIR/app.plist"
"$RUNNER_TEMP/asc-python/bin/python" scripts/ios/ci-signing.py
KEYCHAIN="$RUNNER_TEMP/summon-signing.keychain-db"
KEYCHAIN_PASSWORD=$(openssl rand -hex 24)
echo "::add-mask::$KEYCHAIN_PASSWORD"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$SIGNING_DIR/distribution.p12" -P "$SUMMON_IOS_DISTRIBUTION_P12_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN" >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
cp "$SIGNING_DIR/app.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/summon-ci.mobileprovision"
xcodebuild -project ios/Summon.xcodeproj -scheme SummonBot \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$SIGNING_DIR/Summon.xcarchive" -derivedDataPath "$RUNNER_TEMP/summon-derived" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM="$SUMMON_APPLE_TEAM_ID" PROVISIONING_PROFILE_SPECIFIER="$(cat "$SIGNING_DIR/profile-id")" \
  MARKETING_VERSION="$(cat "$SIGNING_DIR/version")" CURRENT_PROJECT_VERSION="$(cat "$SIGNING_DIR/build")" \
  archive > "$RUNNER_TEMP/summon-archive.log" 2>&1 || { tail -n 120 "$RUNNER_TEMP/summon-archive.log"; exit 1; }
xcodebuild -exportArchive -archivePath "$SIGNING_DIR/Summon.xcarchive" \
  -exportOptionsPlist "$SIGNING_DIR/ExportOptions.plist" -exportPath "$SIGNING_DIR/export" \
  > "$RUNNER_TEMP/summon-export.log" 2>&1 || { tail -n 100 "$RUNNER_TEMP/summon-export.log"; exit 1; }
shopt -s nullglob
IPAS=("$SIGNING_DIR/export/"*.ipa)
if [ "${#IPAS[@]}" -ne 1 ]; then echo 'Expected exactly one IPA' >&2; exit 1; fi
API_PRIVATE_KEYS_DIR="$SIGNING_DIR" xcrun altool --upload-app --type ios \
  --file "${IPAS[0]}" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
echo 'Upload accepted; Apple processing and internal distribution are still pending.' >> "$GITHUB_STEP_SUMMARY"
