import { mkdir, readFile, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyTree, walk, readJson, writeJson, digest, within, parseArgs } from './files.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = ['bot', 'web', 'capabilities', 'connectors', 'roles', 'skills', 'scripts/build', 'scripts/installation', 'scripts/maintenance', 'scripts/release'];
const rootFiles = ['package.json', 'package-lock.json', 'release.json', 'README.md', 'AGENTS.md', 'Start.ps1', 'Start-Hidden.vbs', 'Stop.ps1', 'Run.cmd'];
const docsFiles = ['REFACTOR_PLAN.md', 'ARCHITECTURE.md', 'CHAT_WORK_ISOLATION.md', 'DEPLOYMENT.md', 'OPERATIONS.md', 'VERIFICATION.md', 'CAPABILITY_SERVICES.md', 'CAPABILITY_CATALOG.md', 'DEVELOPMENT.md', 'CLIENT_RELEASES.md', 'BOT_3_PLUS_3_DESIGN.md', 'BOT_3_PLUS_3_IMPLEMENTATION.md', 'BOT_3_PLUS_3_ACCEPTANCE.md', 'EGGBOT.md', 'DESKTOP_INSTALL_ONBOARDING_SPEC.md'];
const include = name => !name.split('/').some(part => ['node_modules', '.git', '.relay', 'test', 'tests', 'coverage', 'dist'].includes(part)
  || /^\.env(?:\.|$)/.test(part) || /(?:\.sqlite(?:-\w+)?|\.log|\.tmp)$/.test(part));

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

export async function buildRelease({ sourceRoot = projectRoot, releaseRoot, bundleNode = true, integrity = false, committedOnly = false } = {}) {
  // These Windows builds contain libuv's uninitialized OSVERSIONINFOW stack
  // overwrite in TCP keepalive (nodejs/node#62561). Never ship them again.
  if (process.platform === 'win32' && ['24.15.0','25.8.0'].includes(process.versions.node)) throw new Error('This Node build has a Windows TCP keepalive native crash. Build with the fixed Node 24.21.0 LTS runtime.');
  sourceRoot = resolve(sourceRoot);
  const git = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  releaseRoot = resolve(releaseRoot || join(sourceRoot, 'dist', 'releases', buildId));
  if (releaseRoot === sourceRoot || within(releaseRoot, sourceRoot)) throw new Error('Release must not contain or replace sourceRoot');
  if (existsSync(releaseRoot)) throw new Error('Release directory already exists; builds never overwrite another release');
  const stage = `${releaseRoot}.building-${process.pid}`;
  await mkdir(dirname(stage), { recursive: true }); await mkdir(stage);
  await writeJson(join(stage, 'build-owner.json'), { sourceRoot, releaseRoot, buildId, pid: process.pid });
  if (committedOnly) {
    const archive = join(stage, 'source.tar');
    if (git.status !== 0) throw new Error('Cannot determine release commit');
    const docListing = spawnSync('git', ['-C', sourceRoot, 'ls-tree', '--name-only', `${git.stdout.trim()}:docs`], { encoding: 'utf8', windowsHide: true });
    if (docListing.status !== 0) throw new Error('Cannot list committed release documents');
    const committedDocs = new Set(docListing.stdout.trim().split(/\r?\n/));
    const exported = spawnSync('git', ['-C', sourceRoot, 'archive', '--format=tar', `--output=${archive}`, git.stdout.trim(), ...directories, ...rootFiles, ...docsFiles.filter(name => committedDocs.has(name)).map(name => `docs/${name}`)], { encoding: 'utf8', windowsHide: true });
    if (exported.status !== 0) throw new Error(`Cannot export committed release source: ${exported.stderr}`);
    const extracted = spawnSync('tar', ['-xf', archive, '-C', stage,
      ...['*/test', '*/tests', '*/node_modules', '*/coverage', '*/dist', '*/.relay', '*/.env*', '*.sqlite*', '*.log', '*.tmp'].map(pattern => `--exclude=${pattern}`)], { encoding: 'utf8', windowsHide: true });
    if (extracted.status !== 0) throw new Error(`Cannot extract release source: ${extracted.stderr}`);
    await unlink(archive);
  } else {
    for (const folder of directories) await copyTree(join(sourceRoot, folder), join(stage, folder), include);
    for (const name of rootFiles) await copyFile(join(sourceRoot, name), join(stage, name));
    await mkdir(join(stage, 'docs'), { recursive: true });
    for (const name of docsFiles) if (existsSync(join(sourceRoot, 'docs', name))) await copyFile(join(sourceRoot, 'docs', name), join(stage, 'docs', name));
  }
  const pkg = await readJson(join(stage, 'package.json')), lock = await readJson(join(stage, 'package-lock.json'));
  const dependencies = [];
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || info.dev || info.link) continue;
    const installed = join(sourceRoot, path);
    if (!existsSync(installed)) { if (info.optional) continue; throw new Error(`Production dependency missing: ${path}`); }
    const actual = await readJson(join(installed, 'package.json'));
    if (info.version && actual.version !== info.version) throw new Error(`Lockfile version mismatch: ${path}`);
    await copyTree(installed, join(stage, path), name => !name.split('/').includes('node_modules'));
    dependencies.push({ path, version: actual.version });
  }
  const workspaces = [];
  for (const folder of pkg.workspaces) {
    if (folder.includes('*')) throw new Error('Release builder requires explicit workspace directories');
    workspaces.push(await materializeWorkspace(stage, folder));
  }
  if (bundleNode) { await mkdir(join(stage, 'runtime'), { recursive: true }); await copyFile(process.execPath, join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')); }
  await unlink(join(stage, 'build-owner.json'));
  const files = {};
  const releaseFiles = await walk(stage);
  for (let index = 0; index < releaseFiles.length; index += 64) {
    const records = await Promise.all(releaseFiles.slice(index, index + 64).map(async file => [file.name, integrity ? { size: file.size, sha256: digest(await readFile(file.path)) } : { size: file.size }]));
    for (const [name, record] of records) files[name] = record;
  }
  const gitStatus = integrity ? spawnSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }) : null;
  const manifest = { format: 2, profile: integrity ? 'release' : 'development', application: pkg.name, version: pkg.version, buildId, builtAt: new Date().toISOString(),
    sourceCommit: git.status === 0 ? git.stdout.trim() : null, sourceDirty: gitStatus?.status === 0 ? Boolean(gitStatus.stdout.trim()) : null,
    contentHash: integrity ? digest(JSON.stringify(files)) : null,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, bundled: bundleNode },
    schemas: { layout: 2, bot: 1, capabilities: 1 }, workspaces, dependencies, files };
  await writeJson(join(stage, 'release-manifest.json'), manifest);
  await rename(stage, releaseRoot);
  return { releaseRoot, buildId, sourceCommit: manifest.sourceCommit, profile: manifest.profile, files: Object.keys(files).length, contentHash: manifest.contentHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  buildRelease({ sourceRoot: options['source-root'], releaseRoot: options['release-root'], bundleNode: !options['no-node'], integrity: options['with-integrity'] === true || options['with-integrity'] === 'true' })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
