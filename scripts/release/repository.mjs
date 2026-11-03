import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validTarget } from './targets.mjs';

export const inside = (root, path) => { const part = relative(resolve(root), resolve(path)); return part && !part.startsWith('..') && !isAbsolute(part); };
export async function removeInside(root, path) {
  root = resolve(root); path = resolve(path);
  if (!inside(root, path)) throw new Error('Refusing cleanup outside the named root');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isSymbolicLink() && !inside(await realpath(root), await realpath(path))) throw new Error('Cleanup target resolves outside its root');
  await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
}
export function validateRelease(value) {
  if (!validTarget(value.platform, value.arch) || !/^\d+\.\d+\.\d+$/.test(value.version)
    || !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 24
    || value.files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|dmg|zip|apk|yml|blockmap)$/.test(file.name)
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 3 * 1024 ** 3)
    || new Set(value.files.map(file => file.name)).size !== value.files.length
    || !value.files.some(file => file.name === value.mainFile)) throw new Error('Invalid client release');
  const extension = value.platform === 'windows' ? '.exe' : value.platform === 'macos' ? '.dmg' : '.apk';
  if (!value.mainFile.endsWith(extension)) throw new Error('Incorrect primary package for platform');
  if (value.platform === 'windows' && !value.files.some(file => file.name === 'latest.yml')) throw new Error('Windows update metadata missing');
  if (value.platform === 'macos' && !value.files.some(file => file.name.endsWith('.zip'))) throw new Error('macOS update ZIP missing');
  return { platform: value.platform, arch: value.arch, version: value.version, buildNumber: value.buildNumber,
    updateMode: value.platform === 'macos' ? 'manual' : 'automatic',
    sourceCommit: typeof value.sourceCommit === 'string' ? value.sourceCommit.slice(0, 80) : null,
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 8000) : '', mainFile: value.mainFile,
    files: value.files.map(file => ({ name: file.name, size: file.size })) };
}

export async function publishRelease(root, input, value) {
  const metadata = validateRelease(value);
  const target = resolve(root, metadata.platform, metadata.arch);
  await mkdir(target, { recursive: true });
  const lock = join(target, '.publishing');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('This platform is already being published'); throw error; }
  const directory = `release-${metadata.version}-${metadata.buildNumber}-${randomUUID().slice(0, 8)}`;
  const stage = join(target, directory);
  let selected = false;
  try {
    const previous = await readFile(join(target, 'current.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && metadata.buildNumber <= previous.buildNumber) throw new Error('Increase release.json buildNumber before publishing another release');
    if (previous && metadata.platform !== 'android') {
      const next = metadata.version.split('.').map(Number), current = previous.version.split('.').map(Number);
      const different = next.findIndex((value, index) => value !== current[index]);
      if (different < 0 || next[different] < current[different]) throw new Error('Increase release.json version before publishing another desktop release');
    }
    await mkdir(stage);
    for (const file of metadata.files) await copyFile(join(input, file.name), join(stage, file.name));
    const record = { ...metadata, directory, publishedAt: new Date().toISOString() };
    const temporary = join(target, `current-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
    await rename(temporary, join(target, 'current.json'));
    selected = true;
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('release-') && entry.name !== directory) await removeInside(target, join(target, entry.name));
    }
    return record;
  } finally {
    if (!selected) await removeInside(target, stage);
    await removeInside(target, lock);
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
