"""Configure only this repository, after checking the actual Apple app and profile."""
import base64
import datetime
import json
import pathlib
import plistlib
import re
import subprocess
import sys

from cryptography.hazmat.primitives.serialization import pkcs12, Encoding
from cryptography.x509.oid import NameOID
from importlib.util import module_from_spec, spec_from_file_location
import os


def main():
    inputs = json.load(sys.stdin)
    shared, app = pathlib.Path(inputs['shared']), pathlib.Path(inputs['app'])
    team = '6Y29E7PSVF'
    p12 = (shared / 'Lin-Gym-Distribution.p12').read_bytes()
    key, cert, _ = pkcs12.load_key_and_certificates(p12, inputs['password'].encode())
    now = datetime.datetime.now(datetime.timezone.utc)
    if key is None or cert is None or not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise ValueError('Distribution private key missing or certificate expired')
    if team not in [x.value for x in cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)]:
        raise ValueError('Wrong certificate team')
    if not any(x.value.startswith('Apple Distribution:') for x in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)):
        raise ValueError('Expected an Apple Distribution certificate')
    raw_profile = (app / 'app.mobileprovision').read_bytes()
    start = raw_profile.index(b'<?xml')
    end = raw_profile.index(b'</plist>', start) + len(b'</plist>')
    profile = plistlib.loads(raw_profile[start:end])
    entitlements = profile.get('Entitlements', {})
    if (profile.get('TeamIdentifier') != [team]
            or entitlements.get('application-identifier') != team + '.org.lin0.summon'
            or entitlements.get('aps-environment') != 'production'
            or entitlements.get('get-task-allow') or profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices')
            or profile['ExpirationDate'] <= now.replace(tzinfo=None)
            or cert.public_bytes(Encoding.DER) not in profile.get('DeveloperCertificates', [])):
        raise ValueError('Profile must be current App Store distribution for Summon, with push and the existing certificate')
    api_path = pathlib.Path(inputs['keyPath'])
    match = re.fullmatch(r'AuthKey_([A-Z0-9]{10})\.p8', api_path.name)
    if not match:
        raise ValueError('Unexpected API key filename')
    issuer = (app / 'asc-issuer-id.txt').read_text(encoding='utf-8-sig').strip()
    if not re.fullmatch(r'[0-9a-fA-F-]{36}', issuer):
        raise ValueError('Invalid App Store Connect issuer ID')
    private_key = api_path.read_text(encoding='utf-8-sig')
    os.environ.update(ASC_KEY_ID=match[1], ASC_ISSUER_ID=issuer, ASC_PRIVATE_KEY=private_key)
    spec = spec_from_file_location('summon_testflight', pathlib.Path(__file__).with_name('ci-testflight.py'))
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    api = module.AppleAPI()
    apps = api(module.query('/v1/apps', **{'filter[bundleId]': 'org.lin0.summon'}))['data']
    if len(apps) != 1:
        raise ValueError('API key cannot see exactly one Summon app; create the correct app record or grant access')
    groups = api('/v1/apps/' + apps[0]['id'] + '/betaGroups?limit=200')['data']
    groups = [g for g in groups if g['attributes']['name'] == inputs['group'] and g['attributes']['isInternalGroup']]
    if len(groups) != 1:
        raise ValueError('Create the selected internal testing group inside Summon Bot first')
    testers = api('/v1/betaGroups/' + groups[0]['id'] + '/betaTesters?limit=1')['data']
    if not testers:
        raise ValueError('Add at least one internal tester to the Summon group')
    repo = 'buyun00/Summon-Bot'
    def gh(args, value):
        result = subprocess.run(['gh', *args, '--repo', repo], input=value, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            print('GitHub operation failed: ' + ' '.join(args) + '; exit=' + str(result.returncode), file=sys.stderr)
            raise RuntimeError('GitHub configuration write failed; check gh authentication and repository permissions')
    secrets = {
        'SUMMON_IOS_DISTRIBUTION_P12_BASE64': base64.b64encode(p12).decode(),
        'SUMMON_IOS_DISTRIBUTION_P12_PASSWORD': inputs['password'],
        'SUMMON_IOS_APP_PROFILE_BASE64': base64.b64encode(raw_profile).decode(),
        'SUMMON_ASC_KEY_ID': match[1], 'SUMMON_ASC_ISSUER_ID': issuer, 'SUMMON_ASC_PRIVATE_KEY': private_key,
    }
    for name, value in secrets.items():
        gh(['secret', 'set', name], value)
    for name, value in {'SUMMON_APPLE_TEAM_ID': team, 'SUMMON_TESTFLIGHT_GROUP': inputs['group'],
                        'SUMMON_IOS_RELEASE_ENABLED': 'true'}.items():
        gh(['variable', 'set', name], value)
    print('Summon profile, certificate and Apple app access checked; GitHub release configuration saved.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(f"Configuration error: {type(error).__name__} at {pathlib.Path(frame.filename).name}:{frame.lineno}", file=sys.stderr)
        # Third-party errors may contain credentials or private file contents.
        print('Configuration incomplete: check private input files, Summon app/group membership, and API/GitHub access.', file=sys.stderr)
        sys.exit(1)
