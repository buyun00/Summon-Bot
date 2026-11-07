import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';

export async function saveArtifact(directory, input, refs = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Artifact requires {name, content} or {name, path}');
  const name = basename(String(input.name || input.path || 'artifact.txt')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-160) || 'artifact';
  const id = randomUUID();
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${id}-${name}`);
  if (input.path !== undefined) await copyFile(resolve(input.path), path);
  else {
    const content = Buffer.isBuffer(input.content) || typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? null, null, 2);
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  }
  const size = (await stat(path)).size;
  return { id, name, path, relativePath: `artifacts/${basename(path)}`, mimeType: input.mimeType || 'application/octet-stream', size, ...refs };
}
