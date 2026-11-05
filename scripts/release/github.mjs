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

async function releaseMetadata(release, endpoint) {
  const asset = release.assets.find(item => item.name === 'latest.json');
  if (!asset) throw new Error(`Missing latest.json for ${release.tag_name}`);
  return validateRelease(JSON.parse(await gh(['api', `${endpoint}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'])));
}

export function releaseDescription(metadata, repository) {
  const platform = { windows: 'Windows', macos: 'macOS', android: 'Android' }[metadata.platform];
  const architecture = metadata.arch === 'universal'
    ? (metadata.platform === 'macos' ? 'Intel / Apple Silicon 通用' : '通用版') : metadata.arch;
  const url = `${githubBase(repository, metadata.platform, metadata.arch)}${encodeURIComponent(metadata.mainFile)}`;
  const instructions = {
    windows: '下载安装程序并运行，按提示完成安装。已安装的用户可通过应用内更新升级。',
    macos: '打开 DMG，将 Summon Bot 拖入 Applications（应用程序）文件夹。更新时先退出应用，再覆盖安装。',
    android: '在 Android 手机上下载并打开 APK，按系统提示允许此次安装；更新时直接覆盖安装。',
  }[metadata.platform];
  return [
    `**${platform} · ${architecture}**　|　版本 **${metadata.version}**`, '',
    `## [下载 Summon Bot](${url})`, '', instructions, '',
    ...(metadata.notes?.trim() ? ['### 更新内容', '', metadata.notes.trim(), ''] : []),
    '---', '',
    '其他平台：[Windows](https://github.com/' + repository + '/releases/tag/client-windows-x64) · [macOS](https://github.com/' + repository + '/releases/tag/client-macos-universal) · [Android](https://github.com/' + repository + '/releases/tag/client-android-universal)', '',
    'iPhone / iPad 请通过 TestFlight 邀请安装。', '',
    '下方 Assets 中的 JSON、YML 和 blockmap 文件用于自动更新，无需手动下载。', '',
  ].join('\n');
}

export async function refreshGithubDescriptions(repository) {
  const endpoint = `repos/${repository}`;
  const releases = await api('GET', `${endpoint}/releases?per_page=100`);
  for (const release of releases.filter(item => !item.draft && item.tag_name.startsWith('client-'))) {
    const metadata = await releaseMetadata(release, endpoint);
    await api('PATCH', `${endpoint}/releases/${release.id}`, { body: releaseDescription(metadata, repository) });
    console.log(`Updated ${release.html_url}`);
  }
}

export async function publishGithub(input, repository) {
  const metadata = validateRelease(JSON.parse(await readFile(join(input, 'artifact.json'), 'utf8')));
  const base = githubBase(repository, metadata.platform, metadata.arch);
  const tag = releaseTag(metadata.platform, metadata.arch);
  const endpoint = `repos/${repository}`;
  let release = await find(`${endpoint}/releases/tags/${tag}`);
  if (release && !release.draft) {
    const previous = await releaseMetadata(release, endpoint);
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
    body: releaseDescription(value, repository), draft: false, make_latest: 'false',
  });
  const current = await api('GET', `${endpoint}/releases/${release.id}`);
  const retained = new Set([...metadata.files.map(file => file.name), 'latest.json']);
  for (const asset of current.assets) if (!retained.has(asset.name)) await api('DELETE', `${endpoint}/releases/assets/${asset.id}`);
  console.log(JSON.stringify({ published: true, source: 'github', platform: metadata.platform, arch: metadata.arch, version: metadata.version, url: current.html_url }));
  return metadata;
}
