"""Wait for this exact build, then verify internal TestFlight distribution.

Does not invite testers, create external groups, or answer encryption questions.
The app declares its exempt encryption usage in its versioned Info.plist.
"""
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
        request = urllib.request.Request('https://api.appstoreconnect.apple.com' + path,
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


def check_build(api, app_id, group, version, build_number):
    response = api(query('/v1/builds', **{'filter[app]': app_id, 'filter[version]': build_number,
                                         'include': 'preReleaseVersion,buildBetaDetail', 'limit': 100}))
    included = {(x['type'], x['id']): x for x in (response.get('included') or [])}
    builds = []
    for build in response.get('data', []):
        release_id = relationship_id(build, 'preReleaseVersion')
        release = included.get(('preReleaseVersions', release_id), {})
        if release.get('attributes', {}).get('version') == version and build['attributes']['version'] == build_number:
            builds.append(build)
    if not builds:
        return 'Waiting for Apple to register the uploaded build', None
    if len(builds) != 1:
        raise RuntimeError('More than one matching build; refusing ambiguous distribution')
    build = builds[0]
    attrs = build['attributes']
    state = attrs['processingState']
    if state in ('FAILED', 'INVALID') or attrs.get('expired'):
        raise RuntimeError('Apple rejected or expired this build: ' + state)
    if state != 'VALID':
        return 'Apple processing: ' + state, None
    if attrs.get('usesNonExemptEncryption') is not False:
        raise RuntimeError('Export compliance is not resolved; inspect the submitted Info.plist and App Store Connect')
    detail_id = relationship_id(build, 'buildBetaDetail')
    detail = included.get(('buildBetaDetails', detail_id))
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
    members = api('/v1/betaGroups/' + group_id + '/relationships/builds?limit=200').get('data', [])
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
    signing = pathlib.Path(os.environ['RUNNER_TEMP']) / 'summon-signing'
    with (signing/'Summon.xcarchive/Products/Applications/Summon Bot.app/Info.plist').open('rb') as file:
        info = plistlib.load(file)
    version, build_number = info['CFBundleShortVersionString'], info['CFBundleVersion']
    api = AppleAPI()
    apps = api(query('/v1/apps', **{'filter[bundleId]': info['CFBundleIdentifier']}))['data']
    if len(apps) != 1:
        raise RuntimeError('Expected exactly one App Store Connect app')
    app_id = apps[0]['id']
    groups = api('/v1/apps/' + app_id + '/betaGroups?limit=200')['data']
    name = os.environ.get('TESTFLIGHT_GROUP', 'Personal')
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
            summary = f'Summon Bot {version} ({build_number}) is processed, export-compliant, and available in internal group {name}.\n'
            print(summary)
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as file:
                    file.write(summary)
            return
        time.sleep(30)
    raise RuntimeError('Apple processing/distribution exceeded 30 minutes. Upload may still succeed; '
                       'inspect App Store Connect before uploading again. Last state: ' + str(previous))


if __name__ == '__main__':
    main()
