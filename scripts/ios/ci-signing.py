"""Prepare signing for the single Summon application; never print private material."""
import datetime
import json
import os
import pathlib
import plistlib
import re

root = pathlib.Path(os.environ['SIGNING_DIR'])
team = os.environ['SUMMON_APPLE_TEAM_ID']
if team != '6Y29E7PSVF':
    raise SystemExit('Unexpected Apple team')
release = json.loads(pathlib.Path('release.json').read_text())
version = release['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise SystemExit('Invalid release version')
# Keep retries unique and greater than the original source build (21).
build = f"{release['buildNumber']}.{int(os.environ['GITHUB_RUN_NUMBER'])}.{int(os.environ['GITHUB_RUN_ATTEMPT'])}"
with (root / 'app.plist').open('rb') as file:
    profile = plistlib.load(file)
entitlements = profile.get('Entitlements', {})
if (profile.get('TeamIdentifier') != [team]
        or entitlements.get('application-identifier') != team + '.org.lin0.summon'
        or entitlements.get('aps-environment') != 'production'):
    raise SystemExit('Profile must match Summon Bundle ID, team, and production push capability')
if profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices') or entitlements.get('get-task-allow'):
    raise SystemExit('An App Store Connect distribution profile is required')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise SystemExit('Provisioning profile expired')
from cryptography import x509
from cryptography.hazmat.primitives.serialization import pkcs12, Encoding
from cryptography.x509.oid import NameOID
key, cert, _ = pkcs12.load_key_and_certificates((root / 'distribution.p12').read_bytes(),
    os.environ['SUMMON_IOS_DISTRIBUTION_P12_PASSWORD'].encode())
if key is None or cert is None:
    raise SystemExit('Distribution certificate must include its private key')
if (team not in [x.value for x in cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)]
        or not any(x.value.startswith('Apple Distribution:') for x in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME))
        or not cert.not_valid_before_utc <= datetime.datetime.now(datetime.timezone.utc) < cert.not_valid_after_utc):
    raise SystemExit('Distribution certificate has wrong team, type, or validity period')
if cert.public_bytes(Encoding.DER) not in profile.get('DeveloperCertificates', []):
    raise SystemExit('Profile does not include the selected distribution certificate')
export = dict(method='app-store-connect', destination='export', signingStyle='manual', teamID=team,
    signingCertificate='Apple Distribution', provisioningProfiles={'org.lin0.summon': profile['UUID']},
    manageAppVersionAndBuildNumber=False, uploadSymbols=True, testFlightInternalTestingOnly=True)
with (root / 'ExportOptions.plist').open('wb') as file:
    plistlib.dump(export, file)
(root / 'profile-id').write_text(profile['UUID'])
(root / 'version').write_text(version)
(root / 'build').write_text(build)
print(f'Summon Bot {version} ({build}): signing configuration ready')
