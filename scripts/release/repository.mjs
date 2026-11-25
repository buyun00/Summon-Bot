import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, readJson, removeInside, writeJson } from '../installation/files.mjs';
import { acquireServiceLock } from '../installation/service-lock.mjs';
import { validateRelease } from '../../web/backend/release-meta.mjs';

export { inside, removeInside, validateRelease };

export const sameRelease = (left, right) => left.buildNumber === right.buildNumber
  && left.version === right.version && left.sourceCommit === right.sourceCommit;

export function assertNewerRelease(next, previous) {
  if (Number.isSafeInteger(previous?.buildNumber) && next.buildNumber <= previous.buildNumber) {
    throw new Error('Increase release.json buildNumber before publishing another release');
  }
  if (next.platform === 'windows' && /^\d+\.\d+\.\d+$/.test(previous?.version || '')) {
    const target = next.version.split('.').map(Number), current = previous.version.split('.').map(Number);
    const different = target.findIndex((number, index) => number !== current[index]);
    if (different < 0 || target[different] < current[different]) throw new Error('Increase release.json version before publishing a Windows updater package');
  }
}

async function cleanLocalReleases(target, record) {
  try {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('release-') && entry.name !== record.directory) await removeInside(target, join(target, entry.name));
    }
    return record;
  } catch (error) {
    return { ...record, cleanupPending: error.message };
  }
}

export async function publishRelease(root, input, value) {
  const metadata = validateRelease(value);
  const target = resolve(root, metadata.platform, metadata.arch);
  await mkdir(target, { recursive: true });
  const bootId = randomUUID();
  const ownership = await acquireServiceLock(target, 'client-release', () => ({
    pid: process.pid, bootId, state: 'publishing',
  }));
  const directory = `release-${metadata.version}-${metadata.buildNumber}-${randomUUID().slice(0, 8)}`;
  const stage = join(target, directory);
  let selected = false;
  try {
    const previous = await readJson(join(target, 'current.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!previous || !sameRelease(metadata, previous)) assertNewerRelease(metadata, previous);
    await mkdir(stage);
    for (const file of metadata.files) await copyFile(join(input, file.name), join(stage, file.name));
    const record = { ...metadata, directory, publishedAt: new Date().toISOString() };
    await writeJson(join(target, 'current.json'), record);
    selected = true;
    return await cleanLocalReleases(target, record);
  } finally {
    try { if (!selected) await removeInside(target, stage); }
    finally { await ownership.close(); }
  }
}

export async function describeArtifacts(input) {
  const files = [];
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (!entry.isFile() || !(/\.(?:exe|dmg|zip|apk|blockmap)$/.test(entry.name) || /^latest(?:-mac)?\.yml$/.test(entry.name))) continue;
    files.push({ name: entry.name, size: (await stat(join(input, entry.name))).size });
  }
  return files;
}
