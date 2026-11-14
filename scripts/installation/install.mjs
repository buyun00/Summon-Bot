import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyTree, parseArgs, readJson, within, writeJson } from '../build/files.mjs';
import { assertClientAvailability } from '../release/availability.mjs';
import { removeInside } from '../release/repository.mjs';
import { currentWriters, enterDrain, finishDrain, installationRequest } from './drain.mjs';
import { advanceInstallation, dataFormat, readInstallationState, writeInstallationState } from './installation-state.mjs';
import { stageConfiguration } from './configuration.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { createDeployment, deploymentPath, startSystem } from './system.mjs';

const run = promisify(execFile);
const launchers = ['Start.ps1', 'Start-Hidden.vbs', 'Stop.ps1', 'Run.cmd'];
const readOptional = async path => {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function entries(folder) {
  try { return await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function candidate(root) {
  const manifest = await readJson(join(root, 'release-manifest.json'));
  if (manifest.format !== 3 || manifest.dataFormat !== dataFormat || manifest.application !== 'summon-bot' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.buildId) || !Number.isSafeInteger(manifest.buildNumber) ||
      !Number.isSafeInteger(manifest.protocolVersion)) {
    throw new Error('This build does not carry the current Summon Bot installation format');
  }
  return manifest;
}

async function stageRelease(releaseRoot, destination, manifest, onCopyProgress) {
  if (await readOptional(join(destination, 'release-manifest.json'))) {
    const installed = await candidate(destination);
    if (installed.buildId !== manifest.buildId || installed.sourceCommit !== manifest.sourceCommit ||
        installed.buildNumber !== manifest.buildNumber || installed.version !== manifest.version) {
      throw new Error('Release build ID belongs to another package');
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.installing-'));
  try {
    await copyTree(releaseRoot, staging, undefined, onCopyProgress);
    await rename(staging, destination);
  } finally { await removeInside(dirname(destination), staging); }
}

async function installLauncher(source, target) {
  const temporary = `${target}.installing`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function cleanReleases({ appRoot, sourceRoot, destination }) {
  for (const entry of await entries(join(appRoot, 'releases'))) {
    const file = join(appRoot, 'releases', entry.name);
    if (resolve(file) !== destination) await removeInside(appRoot, file);
  }
  if (!sourceRoot) return;
  for (const entry of await entries(join(sourceRoot, 'dist', 'releases'))) {
    const owner = Number(/\.building-(\d+)$/.exec(entry.name)?.[1]);
    if (owner) {
      try { process.kill(owner, 0); continue; }
      catch (error) { if (error.code !== 'ESRCH') continue; }
    }
    await removeInside(sourceRoot, join(sourceRoot, 'dist', 'releases', entry.name));
  }
}

async function startSelected(config, appRoot, previousIntent) {
  if (previousIntent === 'stopped') return 'stopped';
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(appRoot, 'Start.ps1'), '-DataRoot', config.dataRoot],
      { windowsHide: true, timeout: 420000 });
  } else {
    await startSystem(config, { respectIntent: true });
  }
  return 'running';
}

export async function installRelease({ releaseRoot, appRoot, dataRoot, sourceRoot, defaultCwd, publicOrigin = '', port = 8787,
  onCopyProgress, onProgress } = {}) {
  releaseRoot = resolve(releaseRoot);
  appRoot = resolve(appRoot);
  dataRoot = resolve(dataRoot);
  if (within(appRoot, dataRoot) || within(dataRoot, appRoot) || within(releaseRoot, dataRoot) || within(dataRoot, releaseRoot)) {
    throw new Error('Business data must be separate from the application and build');
  }
  // A packaged executable on Windows holds its own file open until it exits.
  if (within(join(appRoot, 'releases'), process.execPath)) throw new Error('Run the installer with Node outside the installed release directories');
  if (sourceRoot) {
    sourceRoot = resolve(sourceRoot);
    const source = await readJson(join(sourceRoot, 'package.json'));
    if (source.name !== 'summon-bot') throw new Error('Invalid Summon Bot source root for build cleanup');
  }
  const manifest = await candidate(releaseRoot);
  const destination = join(appRoot, 'releases', manifest.buildId);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  if (within(await realpath(appRoot), await realpath(dataRoot)) || within(await realpath(dataRoot), await realpath(appRoot))) {
    throw new Error('Application and data roots resolve into each other');
  }
  const bootId = randomUUID();
  const ownership = await acquireServiceLock(dataRoot, 'installation', () => ({ pid: process.pid, bootId, state: 'installing' }));
  try {
    let state = await readInstallationState(dataRoot);
    const selected = await readOptional(join(appRoot, 'current.json'));
    const deployment = await readOptional(deploymentPath(dataRoot));
    if (state?.phase === 'done' && state.target_build === manifest.buildId) {
      return { ...selected, sourceCommit: manifest.sourceCommit, runtimeState: deployment.runIntent };
    }
    if (!state || state.phase === 'done') {
      let previousManifest;
      if (deployment) {
        if (!selected || resolve(selected.releaseRoot) !== resolve(deployment.releaseRoot)) throw new Error('The running deployment and installation pointer disagree');
        previousManifest = await candidate(deployment.releaseRoot);
        const owner = currentWriters(deployment);
        const gateway = await owner.gateway();
        if (gateway.state === 'stopped') {
          await owner.assertStopped();
        } else {
          const result = await installationRequest(deployment, gateway);
          if (result.supportsDrain !== true) throw new Error('The current gateway lacks a protocol drain handler');
        }
      }
      if (previousManifest && previousManifest.protocolVersion !== manifest.protocolVersion) {
        await assertClientAvailability({ dataRoot, release: await readJson(join(releaseRoot, 'release.json')), expected: manifest });
      }
      await stageRelease(releaseRoot, destination, manifest, onCopyProgress);
      state = await writeInstallationState(dataRoot, { schemaVersion: 1, phase: 'prepared', migration_id: randomUUID(),
        target_build: manifest.buildId, target_format: manifest.dataFormat, release_root: destination, previous_release: deployment?.releaseRoot ?? null,
        previousIntent: deployment?.runIntent ?? 'running', source_root: sourceRoot ?? deployment?.sourceRoot ?? null });
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    } else if (state.target_build !== manifest.buildId || resolve(state.release_root) !== destination) {
      throw new Error(`Continue installation ${state.target_build} with its staged release`);
    }

    const previous = state.previous_release ? { ...deployment, dataRoot, releaseRoot: state.previous_release } : null;
    const owner = previous && currentWriters(previous);
    if (state.phase === 'prepared') state = await enterDrain({ dataRoot, state, previous, owner });
    if (state.phase === 'draining') {
      state = await finishDrain({ dataRoot, state, previous, owner, onProgress });
      state = await advanceInstallation(dataRoot, state, 'converting');
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    }
    if (state.phase === 'converting') {
      await owner?.assertStopped({ drained: state.drain?.intake_closed === true && state.drain.ready === true });
      const { defaultLimits } = await import(new URL('../../capabilities/platform/resources.mjs', import.meta.url));
      const current = deployment || createDeployment({ dataRoot, releaseRoot: destination, defaultCwd, port });
      await mkdir(current.defaultCwd, { recursive: true });
      await stageConfiguration({ dataRoot, state, deployment: current, defaultLimits, publicOrigin });
      state = await advanceInstallation(dataRoot, state, 'data_ready');
    }
    const selection = { schemaVersion: 1, releaseRoot: destination, buildId: manifest.buildId, dataRoot,
      selectedAt: state.selected_at || new Date().toISOString() };
    if (state.phase === 'data_ready') {
      const next = await readJson(join(dataRoot, 'config', `deployment.${state.migration_id}.json`));
      await writeJson(deploymentPath(dataRoot), next);
      for (const name of launchers) await installLauncher(join(destination, name), join(appRoot, name));
      await writeJson(join(appRoot, 'current.json'), selection);
      state = await advanceInstallation(dataRoot, state, 'runtime_ready', { selected_at: selection.selectedAt });
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    }
    const activeConfig = await readJson(deploymentPath(dataRoot));
    const runtimeState = await startSelected(activeConfig, appRoot, state.previousIntent);
    await cleanReleases({ appRoot, sourceRoot: state.source_root, destination });
    await unlink(join(dataRoot, 'config', `deployment.${state.migration_id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeInstallationState(dataRoot, { schemaVersion: 1, phase: 'done', target_build: manifest.buildId,
      target_format: manifest.dataFormat, release_root: destination });
    return { ...selection, sourceCommit: manifest.sourceCommit, runtimeState };
  } finally { await ownership.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  installRelease({ releaseRoot: options['release-root'], appRoot: options['app-root'], dataRoot: options['data-root'],
    sourceRoot: options['source-root'], defaultCwd: options.cwd, publicOrigin: options['public-origin'], port: options.port,
    onProgress: result => console.log(JSON.stringify(result)),
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
