import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Authoring only: preserve the existing roles/<id>/prompt.md loading contract.
// This does not update installed releases, live Bot configs, or the runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roles = join(root, 'roles');
const readPrompt = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n').trim();
const common = await readPrompt(join(roles, 'common.md'));
const protocol = await readPrompt(join(roles, 'protocol.md'));
const entries = (await readdir(roles, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
const outputs = [];

for (const entry of entries) {
  const directory = join(roles, entry.name);
  let role;
  try {
    role = JSON.parse(await readFile(join(directory, 'role.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const profile = await readPrompt(join(directory, 'profile.md'));
  if (!common || !protocol || !profile) throw new Error(`Prompt text is missing for ${role.id}`);
  outputs.push({ path: join(directory, 'prompt.md'), content: `${common}\n\n${protocol}\n\n${profile}\n` });
}

for (const output of outputs) await writeFile(output.path, output.content, 'utf8');
console.log(`Rendered ${outputs.length} role prompts from common.md, protocol.md, and profile.md.`);
