import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validTarget } from './targets.mjs';
import { readJson, writeJson } from '../build/files.mjs';
import { acquireServiceLock } from '../installation/service-lock.mjs';

export const inside = (root, path) => { const part = relative(resolve(root), resolve(path)); return part && !part.startsWith('..') && !isAbsolute(part); };
export async function removeInside(root, path) {
  root = resolve(root); path = resolve(path);
  if (!inside(root, path)) throw new Error('Refusing cleanup outside the named root');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const actualRoot = await realpath(root);
  const actualPath = info.isSymbolicLink() ? join(await realpath(dirname(path)), relative(dirname(path), path)) : await realpath(path);
  if (!inside(actualRoot, actualPath)) throw new Error('Cleanup target resolves outside its root');
  await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
}
export function validateRelease(value) {
  if (!validTarget(value.platform, value.arch) || !/^\d+\.\d+\.\d+$/.test(value.version)
    || !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1
    || !Array.isArray(value.files) || !value.files.length
    || value.files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|dmg|zip|apk|yml|blockmap)$/.test(file.name)
      || !Number.isSafeInteger(file.size) || file.size < 1)
    || new Set(value.files.map(file => file.name)).size !== value.files.length
    || !value.files.some(file => file.name === value.mainFile)) throw new Error('Invalid client release');
  const extension = value.platform === 'windows' ? '.exe' : value.platform === 'macos' ? '.dmg' : '.apk';
  if (!value.mainFile.endsWith(extension)) throw new Error('Incorrect primary package for platform');
  if (value.platform === 'windows' && !value.files.some(file => file.name === 'latest.yml')) throw new Error('Windows update metadata missing');
  return { platform: value.platform, arch: value.arch, version: value.version, buildNumber: value.buildNumber,
    updateMode: value.platform === 'macos' ? 'manual' : 'automatic',
    sourceCommit: typeof value.sourceCommit === 'string' ? value.sourceCommit.slice(0, 80) : null,
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 8000) : '', mainFile: value.mainFile,
    files: value.files.map(file => ({ name: file.name, size: file.size })) };
}

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
