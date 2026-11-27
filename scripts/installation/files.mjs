import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const within = (root, target) => {
  const part = relative(resolve(root), resolve(target));
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

export const inside = (root, path) => {
  const part = relative(resolve(root), resolve(path));
  return Boolean(part && !part.startsWith('..') && !isAbsolute(part));
};

export async function removeInside(root, path) {
  root = resolve(root);
  path = resolve(path);
  if (!inside(root, path)) throw new Error('Refusing cleanup outside the named root');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const actualRoot = await realpath(root);
  const actualPath = info.isSymbolicLink() ? join(await realpath(dirname(path)), relative(dirname(path), path)) : await realpath(path);
  if (!inside(actualRoot, actualPath)) throw new Error('Cleanup target resolves outside its root');
  await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
}

export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 12) throw error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 30 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function parseArgs(args) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const [key, ...inline] = args[i].slice(2).split('=');
    options[key] = inline.length ? inline.join('=') : args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return { options, positional };
}

export async function walk(root, filter = () => true) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (!filter(name, entry)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Unpackaged symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.push({ name, path });
    }
  }
  await visit(root);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function copyTree(source, destination, filter, onProgress) {
  const files = await walk(source, filter);
  for (let index = 0; index < files.length; index += 64) {
    const batch = files.slice(index, index + 64);
    await Promise.all(batch.map(async file => {
      const target = join(destination, file.name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.path, target);
    }));
    onProgress?.((index + batch.length) / files.length);
  }
}
