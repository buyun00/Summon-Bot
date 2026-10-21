import { readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [];
for (const folder of ['bot/test', 'web/test', 'capabilities/test', 'tests']) {
  for (const name of await readdir(join(root, folder)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    if (name.endsWith('.test.mjs')) files.push(join(root, folder, name));
}
if (!files.length) throw new Error('No tests found');
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code || 0; });
