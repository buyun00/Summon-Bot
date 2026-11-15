import { sign } from 'node:crypto';

const appStoreConnect = 'https://api.appstoreconnect.apple.com';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function testFlightCredentials() {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY } = process.env;
  if (ASC_KEY_ID && ASC_ISSUER_ID && ASC_PRIVATE_KEY) return { id: ASC_KEY_ID, issuer: ASC_ISSUER_ID, key: ASC_PRIVATE_KEY };
  return null;
}

async function appleApi(path, params, auth, { allowMissing = false } = {}) {
  const url = new URL(path, appStoreConnect);
  if (url.origin !== appStoreConnect) throw new Error('Unexpected App Store Connect pagination URL');
  if (params) url.search = new URLSearchParams(params);
  const now = Math.floor(Date.now() / 1000);
  const jwt = encode({ alg: 'ES256', kid: auth.id, typ: 'JWT' }) + '.'
    + encode({ iss: auth.issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  const signature = sign('sha256', Buffer.from(jwt), { key: auth.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + jwt + '.' + signature }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404 && allowMissing) return {};
  if (!response.ok) throw new Error(`App Store Connect returned HTTP ${response.status} for ${url.pathname}`);
  return response.json();
}

async function* applePages(path, params, auth) {
  let page = await appleApi(path, params, auth);
  while (true) {
    yield page;
    if (!page.links?.next) return;
    page = await appleApi(page.links.next, null, auth);
  }
}

const relationship = (item, name) => item.relationships?.[name]?.data?.id;

export async function findTestFlightBuild(version, numbers, groupName, auth) {
  const apps = await appleApi('/v1/apps', { 'filter[bundleId]': 'org.lin0.summon' }, auth);
  if (apps.data.length !== 1) throw new Error('App Store Connect did not return the Summon Bot app');
  const app = apps.data[0].id;
  const groups = [];
  for await (const page of applePages(`/v1/apps/${app}/betaGroups`, { limit: 200 }, auth)) {
    groups.push(...page.data.filter(group => group.attributes.isInternalGroup && group.attributes.name === groupName));
  }
  if (groups.length !== 1) throw new Error(`App Store Connect did not return one internal group named ${groupName}`);
  const candidates = new Map();
  for (const number of numbers) {
    for await (const page of applePages('/v1/builds', {
      'filter[app]': app, 'filter[version]': number, include: 'preReleaseVersion,buildBetaDetail', limit: 100,
    }, auth)) {
      for (const build of page.data) {
        if (build.attributes.expired || build.attributes.processingState !== 'VALID' || build.attributes.version !== number) continue;
        const included = page.included || [];
        const release = included.find(item => item.type === 'preReleaseVersions' && item.id === relationship(build, 'preReleaseVersion'));
        if (release?.attributes.version !== version) continue;
        const detail = included.find(item => item.type === 'buildBetaDetails' && item.id === relationship(build, 'buildBetaDetail'))
          || (await appleApi(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`, null, auth, { allowMissing: true })).data;
        if (detail?.attributes.internalBuildState === 'IN_BETA_TESTING') candidates.set(build.id, number);
      }
    }
  }
  if (!candidates.size) return null;
  for await (const page of applePages(`/v1/betaGroups/${groups[0].id}/relationships/builds`, { limit: 200 }, auth)) {
    for (const item of page.data) {
      if (candidates.has(item.id)) return candidates.get(item.id);
    }
  }
  return null;
}
