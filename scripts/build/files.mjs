import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, copyFile, rename } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const within = (root, target) => { const part = relative(resolve(root), resolve(target)); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
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
      else if (entry.isFile()) entries.push({ name, path, size: (await lstat(path)).size });
    }
  }
  await visit(root); return entries.sort((a, b) => a.name.localeCompare(b.name));
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
