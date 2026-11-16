import { mkdir, readFile, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyTree, readJson, writeJson, within, parseArgs } from './files.mjs';
import { removeInside } from '../release/repository.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = ['bot', 'web', 'capabilities', 'roles', 'skills', 'scripts/build', 'scripts/installation', 'scripts/maintenance', 'scripts/release'];
const rootFiles = ['package.json', 'package-lock.json', 'release.json', 'README.md', 'README.zh-CN.md', 'AGENTS.md', 'Start.ps1', 'Start-Hidden.vbs', 'Stop.ps1', 'Run.cmd'];
const docsFiles = ['ARCHITECTURE.md', 'DEPLOYMENT.md', 'OPERATIONS.md', 'DEVELOPMENT.md', 'CLIENT_RELEASES.md', 'MODEL_CONNECTIONS.md', 'EGGBOT.md', 'IOS_TESTFLIGHT.md', 'MACOS_SIGNING.md'];
const include = name => !name.split('/').some(part => ['node_modules', '.git', '.relay', 'test', 'tests', 'coverage', 'dist'].includes(part)
  || /^\.env(?:\.|$)/.test(part) || /(?:\.sqlite(?:-\w+)?|\.log|\.tmp)$/.test(part));

export async function copyProductionDependencies(sourceRoot, stage) {
  const lock = await readJson(join(stage, 'package-lock.json'));
  const dependencies = [];
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || info.dev || info.link) continue;
    const installed = join(sourceRoot, path);
    if (!existsSync(installed)) {
      if (info.optional) continue;
      throw new Error(`Production dependency missing: ${path}`);
    }
    const actual = await readJson(join(installed, 'package.json'));
    if (info.version && actual.version !== info.version) throw new Error(`Lockfile version mismatch: ${path}`);
    await copyTree(installed, join(stage, path), name => !name.split('/').includes('node_modules'));
    dependencies.push({ path, version: actual.version });
  }
  return dependencies;
}

/** Emit portable public entry modules instead of filesystem workspace links. */
async function materializeWorkspace(root, folder) {
  const pkg = await readJson(join(root, folder, 'package.json'));
  const destination = join(root, 'node_modules', pkg.name);
  const declared = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports || { '.': pkg.main || './index.js' };
  const exports = {};
  await mkdir(destination, { recursive: true });
  let index = 0;
  for (const [key, value] of Object.entries(declared)) {
    const target = typeof value === 'string' ? value : value?.import || value?.default;
    if (!target || key.includes('*') || !target.startsWith('./')) throw new Error(`Unsupported workspace export ${pkg.name}:${key}`);
    const original = resolve(root, folder, target);
    if (!within(join(root, folder), original) || !existsSync(original)) throw new Error(`Missing workspace entry: ${pkg.name}:${key}`);
    const filename = `entry-${index++}.mjs`, importPath = relative(destination, original).replaceAll('\\', '/');
    await writeFile(join(destination, filename), `export * from ${JSON.stringify(importPath)};\nimport * as entry from ${JSON.stringify(importPath)};\nexport default entry.default;\n`);
    exports[key] = `./${filename}`;
  }
  await writeJson(join(destination, 'package.json'), { name: pkg.name, version: pkg.version, type: 'module', private: true, exports });
  return { name: pkg.name, version: pkg.version, source: folder, entries: Object.keys(exports) };
}

export async function buildRelease({ sourceRoot = projectRoot, releaseRoot, bundleNode = true, committedOnly = false, commit } = {}) {
  // These Windows builds contain libuv's uninitialized OSVERSIONINFOW stack
  // overwrite in TCP keepalive (nodejs/node#62561). Never ship them again.
  if (process.platform === 'win32' && ['24.15.0','25.8.0'].includes(process.versions.node)) throw new Error('This Node build has a Windows TCP keepalive native crash. Build with the fixed Node 24.21.0 LTS runtime.');
  sourceRoot = resolve(sourceRoot);
  const git = spawnSync('git', ['-C', sourceRoot, 'rev-parse', commit || 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const sourceCommit = git.status === 0 ? git.stdout.trim() : null;
  if (committedOnly && !sourceCommit) throw new Error('Cannot determine release commit');
  const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  releaseRoot = resolve(releaseRoot || join(sourceRoot, 'dist', 'releases', buildId));
  if (releaseRoot === sourceRoot || within(releaseRoot, sourceRoot)) throw new Error('Release must not contain or replace sourceRoot');
  if (existsSync(releaseRoot)) throw new Error('Release directory already exists; builds never overwrite another release');
  const stage = `${releaseRoot}.building-${process.pid}`;
  await mkdir(dirname(stage), { recursive: true }); await mkdir(stage);
  try {
    await exportSource({ sourceRoot, stage, committedOnly, sourceCommit });
    const pkg = await readJson(join(stage, 'package.json'));
    const release = await readJson(join(stage, 'release.json'));
    const { protocolVersion } = await import(pathToFileURL(join(stage, 'capabilities/platform/contract.mjs')));
    const { dataFormat } = await import(pathToFileURL(join(stage, 'scripts/installation/installation-state.mjs')));
    const dependencies = await copyProductionDependencies(sourceRoot, stage);
    const workspaces = [];
    for (const folder of pkg.workspaces) {
      if (folder.includes('*')) throw new Error('Release builder requires explicit workspace directories');
      workspaces.push(await materializeWorkspace(stage, folder));
    }
    if (bundleNode) {
      await mkdir(join(stage, 'runtime'), { recursive: true });
      await copyFile(process.execPath, join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
    }
    const gitStatus = committedOnly ? null : spawnSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const manifest = { format: 3, dataFormat, protocolVersion, application: pkg.name, version: release.version, buildNumber: release.buildNumber,
      buildId, builtAt: new Date().toISOString(), sourceCommit, sourceMode: committedOnly ? 'git-archive' : 'workspace',
      sourceDirty: committedOnly ? false : gitStatus.status === 0 ? Boolean(gitStatus.stdout.trim()) : null,
      runtime: { node: process.version, platform: process.platform, arch: process.arch, bundled: bundleNode },
      workspaces, dependencies };
    await writeJson(join(stage, 'release-manifest.json'), manifest);
    await rename(stage, releaseRoot);
    return { releaseRoot, buildId, buildNumber: manifest.buildNumber, sourceCommit };
  } finally { await removeInside(dirname(stage), stage); }
}

export async function exportCommittedPaths(sourceRoot, stage, sourceCommit, paths, excludes = []) {
  const archive = join(stage, 'source.tar');
  const listing = spawnSync('git', ['-C', sourceRoot, 'ls-tree', '--name-only', sourceCommit, '--', ...paths], { encoding: 'utf8', windowsHide: true });
  if (listing.status !== 0) throw new Error('Cannot list committed release files');
  const selected = listing.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!selected.length) throw new Error('No release files found in the selected commit');
  const exported = spawnSync('git', ['-C', sourceRoot, 'archive', '--format=tar', `--output=${archive}`, sourceCommit, ...selected], { encoding: 'utf8', windowsHide: true });
  if (exported.status !== 0) throw new Error(`Cannot export committed release source: ${exported.stderr || exported.error?.message || 'git failed'}`);
  try {
    const extracted = spawnSync('tar', [...excludes.map(pattern => `--exclude=${pattern}`), '-xf', archive, '-C', stage], { encoding: 'utf8', windowsHide: true });
    if (extracted.status !== 0) throw new Error(`Cannot extract release source: ${extracted.stderr || extracted.error?.message || 'tar failed'}`);
  } finally { await unlink(archive); }
}

async function exportSource({ sourceRoot, stage, committedOnly, sourceCommit }) {
  if (committedOnly) {
    const excludes = ['*/test', '*/tests', '*/node_modules', '*/coverage', '*/dist', '*/.relay', '*/.env*', '*.sqlite*', '*.log', '*.tmp'];
    await exportCommittedPaths(sourceRoot, stage, sourceCommit, [...directories, ...rootFiles, ...docsFiles.map(name => `docs/${name}`)], excludes);
  } else {
    for (const folder of directories) if (existsSync(join(sourceRoot, folder))) await copyTree(join(sourceRoot, folder), join(stage, folder), include);
    for (const name of rootFiles) await copyFile(join(sourceRoot, name), join(stage, name));
    await mkdir(join(stage, 'docs'), { recursive: true });
    for (const name of docsFiles) if (existsSync(join(sourceRoot, 'docs', name))) await copyFile(join(sourceRoot, 'docs', name), join(stage, 'docs', name));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  buildRelease({ sourceRoot: options['source-root'], releaseRoot: options['release-root'], bundleNode: !options['no-node'], committedOnly: Boolean(options['committed-only']) })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
