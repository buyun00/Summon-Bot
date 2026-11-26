import { createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// GitHub's release-download frontend can fail while its documented asset API
// and asset storage remain available. Fetch the same upstream release assets
// into the normal dependency caches; the build keeps its existing validation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const retryable = new Set([408, 429, 500, 502, 503, 504]);
const storageHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function request(url, accept, label) {
  const headers = { Accept: accept, 'User-Agent': 'Summon-Bot-client-release' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(600000) });
  if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    throw Object.assign(new Error(`HTTP ${response.status} fetching ${label}`), { retryable: retryable.has(response.status) });
  }
  return response;
}

async function retry(label, operation) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 4 || !(error.retryable || error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name))) throw error;
      console.log(`Retrying ${label} after ${error.message} (${attempt}/4)`);
      await delay(1500 * 2 ** (attempt - 1));
    }
  }
}

const releases = new Map();
async function download(repository, tag, name, destination) {
  if (existsSync(destination)) {
    console.log(`Using cached dependency ${name}`);
    return;
  }
  const label = `${repository}@${tag}/${name}`;
  const releaseUrl = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  if (!releases.has(releaseUrl)) releases.set(releaseUrl, retry(`${repository}@${tag}`, async () => {
    const response = await request(releaseUrl, 'application/vnd.github+json', `${repository}@${tag}`);
    return response.json();
  }));
  const release = await releases.get(releaseUrl);
  const asset = release.assets.find(item => item.name === name);
  if (!asset) throw new Error(`Missing official release asset ${label}`);
  const assetUrl = `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`;
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  console.log(`Downloading official dependency ${label} through GitHub Release Assets API`);
  await retry(label, async () => {
    try {
      let response = await request(assetUrl, 'application/octet-stream', label);
      for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const target = location && new URL(location, assetUrl);
        if (redirects >= 5 || !target || target.protocol !== 'https:' || !storageHosts.has(target.hostname)) {
          throw new Error(`Unexpected GitHub asset redirect for ${label}`);
        }
        // The API credential never goes to the redirected storage host.
        response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(600000) });
        if (!response.ok && !(response.status >= 300 && response.status < 400)) {
          await response.body?.cancel();
          throw Object.assign(new Error(`HTTP ${response.status} downloading ${label}`), { retryable: retryable.has(response.status) });
        }
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new Error(`GitHub returned metadata instead of binary content for ${label}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  });
}

async function android() {
  const propertiesPath = join(root, 'android/gradle/wrapper/gradle-wrapper.properties');
  const properties = await readFile(propertiesPath, 'utf8');
  const name = properties.match(/^distributionUrl=.*\/(gradle-(\d+(?:\.\d+)+)-(?:bin|all)\.zip)\s*$/m);
  if (!name) return;
  const destination = join(process.env.RUNNER_TOOL_CACHE, 'summon-ci-dependencies', name[1]);
  await download('gradle/gradle-distributions', `v${name[2]}`, name[1], destination);
  // The release command applies this cache path only to its isolated build.
  await appendFile(process.env.GITHUB_ENV, `SUMMON_GRADLE_DISTRIBUTION=${destination}\n`);
}

try {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Dependency preparation is for GitHub Actions only');
  if (process.argv[2] === 'android') await android();
  else throw new Error('Use android');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
