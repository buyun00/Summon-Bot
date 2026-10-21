import { mkdir, readFile, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyTree, walk, readJson, writeJson, digest, within, parseArgs } from './files.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = ['bot', 'web', 'capabilities', 'roles', 'skills', 'scripts/build', 'scripts/installation', 'scripts/migration'];
const rootFiles = ['package.json', 'package-lock.json', 'README.md', 'Start.ps1', 'Stop.ps1', 'Run.cmd'];
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

export async function buildRelease({ sourceRoot = projectRoot, releaseRoot, bundleNode = true } = {}) {
  sourceRoot = resolve(sourceRoot);
  const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  releaseRoot = resolve(releaseRoot || join(sourceRoot, 'dist', 'releases', buildId));
  if (releaseRoot === sourceRoot || within(releaseRoot, sourceRoot)) throw new Error('Release must not contain or replace sourceRoot');
  if (existsSync(releaseRoot)) throw new Error('Release directory already exists; builds never overwrite another release');
  const stage = `${releaseRoot}.building-${process.pid}`;
  await mkdir(dirname(stage), { recursive: true }); await mkdir(stage);
  await writeJson(join(stage, 'build-owner.json'), { sourceRoot, releaseRoot, buildId, pid: process.pid });
  const pkg = await readJson(join(sourceRoot, 'package.json')), lock = await readJson(join(sourceRoot, 'package-lock.json'));
  for (const folder of directories) await copyTree(join(sourceRoot, folder), join(stage, folder), include);
  for (const name of rootFiles) await copyFile(join(sourceRoot, name), join(stage, name));
  await mkdir(join(stage, 'docs'), { recursive: true });
  for (const name of ['REFACTOR_PLAN.md', 'ARCHITECTURE.md', 'OPERATIONS.md', 'VERIFICATION.md']) if (existsSync(join(sourceRoot, 'docs', name))) await copyFile(join(sourceRoot, 'docs', name), join(stage, 'docs', name));
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
    const records = await Promise.all(releaseFiles.slice(index, index + 64).map(async file => [file.name, { size: file.size, sha256: digest(await readFile(file.path)) }]));
    for (const [name, record] of records) files[name] = record;
  }
  const git = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const gitStatus = spawnSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const manifest = { format: 2, application: pkg.name, version: pkg.version, buildId, builtAt: new Date().toISOString(),
    sourceCommit: git.status === 0 ? git.stdout.trim() : null, sourceDirty: gitStatus.status === 0 ? Boolean(gitStatus.stdout.trim()) : null,
    contentHash: digest(JSON.stringify(files)),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, bundled: bundleNode },
    schemas: { layout: 2, bot: 1, capabilities: 1 }, workspaces, dependencies, files };
  await writeJson(join(stage, 'release-manifest.json'), manifest);
  await rename(stage, releaseRoot);
  return { releaseRoot, buildId, files: Object.keys(files).length, contentHash: manifest.contentHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  buildRelease({ sourceRoot: options['source-root'], releaseRoot: options['release-root'], bundleNode: !options['no-node'] })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
