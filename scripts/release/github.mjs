import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { githubBase, releaseTag } from './targets.mjs';
import { validateRelease } from './repository.mjs';

async function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(error.trim() || `gh exited with code ${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function api(method, path, value) {
  const output = await gh(['api', '--method', method, path, ...(value === undefined ? [] : ['--input', '-'])],
    value === undefined ? undefined : JSON.stringify(value));
  return output.trim() ? JSON.parse(output) : null;
}
async function find(path) {
  try { return await api('GET', path); }
  catch (error) { if (/\b404\b/.test(error.message)) return null; throw error; }
}

export async function publishGithub(input, repository) {
  const metadata = validateRelease(JSON.parse(await readFile(join(input, 'artifact.json'), 'utf8')));
  const base = githubBase(repository, metadata.platform, metadata.arch);
  const tag = releaseTag(metadata.platform, metadata.arch);
  const endpoint = `repos/${repository}`;
  let release = await find(`${endpoint}/releases/tags/${tag}`);
  if (release && !release.draft) {
    const previous = JSON.parse(release.body);
    if (metadata.buildNumber <= previous.buildNumber) throw new Error(`Increase release.json buildNumber before publishing ${tag} again`);
  }
  const ref = await find(`${endpoint}/git/ref/tags/${tag}`);
  if (!ref) await api('POST', `${endpoint}/git/refs`, { ref: `refs/tags/${tag}`, sha: metadata.sourceCommit });
  if (!release) release = await api('POST', `${endpoint}/releases`, { tag_name: tag, name: tag, draft: true, make_latest: 'false' });

  const value = { ...metadata, source: 'github', publishedAt: new Date().toISOString(),
    downloadUrl: `${base}${encodeURIComponent(metadata.mainFile)}`,
    files: metadata.files.map(file => ({ ...file, url: `${base}${encodeURIComponent(file.name)}` })) };
  await writeFile(join(input, 'latest.json'), JSON.stringify(value, null, 2) + '\n');
  // Packages arrive first; only then switch the updater channel and public catalog.
  for (const files of [metadata.files.filter(file => !file.name.endsWith('.yml')).map(file => file.name),
    metadata.files.filter(file => file.name.endsWith('.yml')).map(file => file.name), ['latest.json']]) {
    if (files.length) await gh(['release', 'upload', tag, ...files.map(name => join(input, name)), '--repo', repository, '--clobber']);
  }
  await api('PATCH', `${endpoint}/git/refs/tags/${tag}`, { sha: metadata.sourceCommit, force: true });
  await api('PATCH', `${endpoint}/releases/${release.id}`, {
    name: `Summon Bot ${metadata.version} · ${metadata.platform} ${metadata.arch}`,
    body: JSON.stringify(value, null, 2), draft: false, make_latest: 'false',
  });
  const current = await api('GET', `${endpoint}/releases/${release.id}`);
  const retained = new Set([...metadata.files.map(file => file.name), 'latest.json']);
  for (const asset of current.assets) if (!retained.has(asset.name)) await api('DELETE', `${endpoint}/releases/assets/${asset.id}`);
  console.log(JSON.stringify({ published: true, source: 'github', platform: metadata.platform, arch: metadata.arch, version: metadata.version, url: current.html_url }));
  return metadata;
}
