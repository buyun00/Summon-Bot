"""Resume processing and internal TestFlight delivery for one uploaded build."""
import argparse
import json
import os
import pathlib
import plistlib
import time
import urllib.error
import urllib.parse
import urllib.request


class AppleAPI:
    def __call__(self, path, body=None, *, allow_missing=False):
        import jwt
        now = int(time.time())
        token = jwt.encode(dict(iss=os.environ['ASC_ISSUER_ID'], iat=now, exp=now + 600,
                                aud='appstoreconnect-v1'), os.environ['ASC_PRIVATE_KEY'],
                           algorithm='ES256', headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})
        url = urllib.parse.urljoin('https://api.appstoreconnect.apple.com/', path)
        if urllib.parse.urlsplit(url).netloc != 'api.appstoreconnect.apple.com' or not url.startswith('https://'):
            raise RuntimeError('Unexpected App Store Connect pagination URL')
        request = urllib.request.Request(url,
            data=json.dumps(body).encode() if body else None,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404:
                return {}
            if error.code == 429 or error.code >= 500:
                raise ConnectionError(f'Apple temporarily unavailable (HTTP {error.code})') from None
            raise RuntimeError(f'Apple API HTTP {error.code} for {path.split("?")[0]}; '
                               'check API key permissions and the internal group configuration') from None
        except urllib.error.URLError:
            raise ConnectionError('Apple API connection failed') from None


def query(path, **params):
    return path + '?' + urllib.parse.urlencode(params)


def relationship_id(resource, name):
    relationships = resource.get('relationships') or {}
    relationship = relationships.get(name) or {}
    return (relationship.get('data') or {}).get('id')


def pages(api, path):
    while path:
        response = api(path)
        yield response
        path = (response.get('links') or {}).get('next')


def records(api, path):
    for page in pages(api, path):
        yield from page.get('data', [])


def check_build(api, app_id, group, version, build_number):
    path = query('/v1/builds', **{'filter[app]': app_id, 'filter[version]': build_number,
                                'include': 'preReleaseVersion,buildBetaDetail', 'limit': 100})
    builds = []
    for response in pages(api, path):
        included = {(x['type'], x['id']): x for x in (response.get('included') or [])}
        for build in response.get('data', []):
            release_id = relationship_id(build, 'preReleaseVersion')
            release = included.get(('preReleaseVersions', release_id), {})
            if release.get('attributes', {}).get('version') == version and build['attributes']['version'] == build_number:
                detail = included.get(('buildBetaDetails', relationship_id(build, 'buildBetaDetail')))
                builds.append((build, detail))
    if not builds:
        return 'Waiting for Apple to register the uploaded build', None
    if len(builds) != 1:
        raise RuntimeError('More than one matching build; refusing ambiguous distribution')
    build, detail = builds[0]
    attrs = build['attributes']
    state = attrs['processingState']
    if state in ('FAILED', 'INVALID') or attrs.get('expired'):
        raise RuntimeError('Apple rejected or expired this build: ' + state)
    if state != 'VALID':
        return 'Apple processing: ' + state, None
    if not detail:
        path = '/v1/builds/' + urllib.parse.quote(build['id'], safe='') + '/buildBetaDetail'
        detail = api(path, allow_missing=True).get('data')
    beta = ((detail or {}).get('attributes') or {}).get('internalBuildState')
    if not beta:
        return 'Waiting for Apple to report this build’s internal beta state', None
    if beta == 'MISSING_EXPORT_COMPLIANCE':
        raise RuntimeError('Apple requires export compliance information')
    if beta not in ('READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'):
        return 'Internal testing state: ' + str(beta), None
    group_id = group['id']
    members = records(api, '/v1/betaGroups/' + group_id + '/relationships/builds?limit=200')
    linked = any(item['id'] == build['id'] for item in members)
    if not linked:
        if group['attributes'].get('hasAccessToAllBuilds'):
            return 'Waiting for automatic internal group distribution', None
        api('/v1/betaGroups/' + group_id + '/relationships/builds',
            {'data': [{'type': 'builds', 'id': build['id']}]})
        return 'Added to internal group; waiting for read-back', None
    if beta != 'IN_BETA_TESTING':
        return 'Group linked; waiting for internal testing activation', None
    return 'Available in internal TestFlight', build['id']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version')
    parser.add_argument('--build-number')
    args = parser.parse_args()
    if bool(args.version) != bool(args.build_number):
        parser.error('provide both --version and --build-number to resume a previous upload')
    bundle = 'org.lin0.summon'
    if args.version:
        version, build_number = args.version, args.build_number
    else:
        signing = pathlib.Path(os.environ['RUNNER_TEMP']) / 'summon-signing'
        with (signing/'Summon.xcarchive/Products/Applications/Summon Bot.app/Info.plist').open('rb') as file:
            info = plistlib.load(file)
        bundle = info['CFBundleIdentifier']
        version, build_number = info['CFBundleShortVersionString'], info['CFBundleVersion']
    api = AppleAPI()
    apps = list(records(api, query('/v1/apps', **{'filter[bundleId]': bundle})))
    if len(apps) != 1:
        raise RuntimeError('Expected exactly one App Store Connect app')
    app_id = apps[0]['id']
    groups = records(api, '/v1/apps/' + app_id + '/betaGroups?limit=200')
    name = os.environ.get('TESTFLIGHT_GROUP') or 'Personal'
    groups = [g for g in groups if g['attributes']['name'] == name and g['attributes']['isInternalGroup']]
    if len(groups) != 1:
        raise RuntimeError('Expected one existing internal group named ' + name)
    deadline = time.monotonic() + 1800
    previous = None
    while time.monotonic() < deadline:
        try:
            status, build_id = check_build(api, app_id, groups[0], version, build_number)
        except ConnectionError as error:
            status, build_id = str(error), None
        if status != previous:
            print(f'{version} ({build_number}): {status}', flush=True)
            previous = status
        if build_id:
            summary = f'Summon Bot {version} ({build_number}) is available in internal TestFlight group {name}.\n'
            print(summary)
            print('TestFlight availability ' + json.dumps(dict(
                available=True, version=version, build=build_number, group=name)))
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as file:
                    file.write(summary)
            return
        time.sleep(30)
    summary = (f'TestFlight distribution is pending for {version} ({build_number}). '
               f'Last Apple state: {previous}. Use the resume action with this version and build number.\n')
    print('::notice::' + summary.strip())
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as file:
            file.write(summary)


if __name__ == '__main__':
    main()
