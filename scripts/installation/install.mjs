import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, parseArgs, readJson, removeInside, within, writeJson } from './files.mjs';
import { assertClientAvailability } from '../release/availability.mjs';
import { currentWriters, enterDrain, finishDrain, installationRequest } from './drain.mjs';
import { advanceInstallation, dataFormat, readInstallationState, writeInstallationState } from './installation-state.mjs';
import { stageConfiguration } from './configuration.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { createDeployment, deploymentPath, startSystem } from './system.mjs';

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
  if (manifest.application !== 'summon-bot') throw new Error('This package is not a Summon Bot installation');
  if (manifest.format !== 3) throw new Error(`Unsupported installation manifest format: ${manifest.format}`);
  if (manifest.dataFormat !== dataFormat) throw new Error(`Package data format ${manifest.dataFormat} does not match ${dataFormat}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.buildId || '')) throw new Error('Invalid release buildId');
  if (!Number.isSafeInteger(manifest.buildNumber)) throw new Error('Invalid release buildNumber');
  if (!Number.isSafeInteger(manifest.protocolVersion)) throw new Error('Invalid release protocolVersion');
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

async function startSelected(config, appRoot, previousIntent, resumeRuntime) {
  if (previousIntent === 'stopped' || config.runIntent === 'stopped') return 'stopped';
  if (process.platform === 'win32' && !resumeRuntime) {
    const args = ['-NoProfile', '-NonInteractive', '-File', join(appRoot, 'Start.ps1'), '-DataRoot', config.dataRoot, '-RespectIntent'];
    await new Promise((accept, reject) => {
      const launcher = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      const timer = setTimeout(() => {
        launcher.kill();
        reject(new Error('The Windows launcher did not exit before its startup deadline'));
      }, 420000);
      launcher.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      // A detached service can retain an inherited console handle. The launcher
      // exit reports startup, independently of when all its handles close.
      launcher.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) accept();
        else reject(new Error(`The Windows launcher exited with ${code ?? signal}`));
      });
    });
  } else {
    const services = await startSystem(config, { respectIntent: true });
    if (services.state === 'stopped') return 'stopped';
  }
  return 'running';
}

export async function installRelease({ releaseRoot, appRoot, dataRoot, sourceRoot, defaultCwd, publicOrigin = '', port = 8787,
  onCopyProgress, onProgress, replacePending = false, requireClients = false, drainTimeoutMs, signal } = {}) {
  signal?.throwIfAborted();
  releaseRoot = resolve(releaseRoot);
  appRoot = resolve(appRoot);
  dataRoot = resolve(dataRoot);
  if (within(appRoot, dataRoot) || within(dataRoot, appRoot) || within(releaseRoot, dataRoot) || within(dataRoot, releaseRoot)) {
    throw new Error('Business data must be separate from the application and build');
  }
  if (sourceRoot) {
    sourceRoot = resolve(sourceRoot);
    const source = await readJson(join(sourceRoot, 'package.json'));
    if (source.name !== 'summon-bot') throw new Error('Invalid Summon Bot source root for build cleanup');
  }
  const manifest = await candidate(releaseRoot);
  const destination = join(appRoot, 'releases', manifest.buildId);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  const [actualApp, actualData, actualPackage] = await Promise.all([realpath(appRoot), realpath(dataRoot), realpath(releaseRoot)]);
  if ([actualApp, actualPackage].some(root => within(root, actualData) || within(actualData, root))) {
    throw new Error('Application, package and business data must resolve to separate directories');
  }
  const releases = join(appRoot, 'releases');
  await mkdir(releases, { recursive: true });
  const actualReleases = await realpath(releases);
  if (actualReleases === actualApp || !within(actualApp, actualReleases)) throw new Error('Installed releases resolve outside the application directory');
  const actualDestination = await realpath(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (actualDestination && (actualDestination === actualReleases || !within(actualReleases, actualDestination))) {
    throw new Error('Installation target resolves outside the release directory');
  }
  // Windows keeps the invoking runtime executable open until the installer exits.
  if (process.platform === 'win32' && within(actualReleases, await realpath(process.execPath))) {
    throw new Error('Run the installer with Node outside the installed release directories');
  }
  const bootId = randomUUID();
  const ownership = await acquireServiceLock(dataRoot, 'installation', () => ({ pid: process.pid, bootId, state: 'installing' }));
  try {
    let state = await readInstallationState(dataRoot);
    const selected = await readOptional(join(appRoot, 'current.json'));
    const deployment = await readOptional(deploymentPath(dataRoot));
    const resumeRuntime = state?.phase === 'runtime_ready' && state.target_build === manifest.buildId;
    if (state?.phase === 'done' && state.target_build === manifest.buildId) {
      return { ...selected, sourceCommit: manifest.sourceCommit, runtimeState: deployment.runIntent };
    }
    const rebuildingSelected = replacePending && state?.phase === 'runtime_ready' && state.target_build !== manifest.buildId;
    if (!state || state.phase === 'done' || rebuildingSelected) {
      let previousManifest;
      if (deployment) {
        if (!selected || resolve(selected.releaseRoot) !== resolve(deployment.releaseRoot)) throw new Error('The running deployment and installation pointer disagree');
        previousManifest = await candidate(deployment.releaseRoot);
        const owner = currentWriters(deployment);
        const gateway = await owner.gateway();
        if (gateway.state === 'ready') {
          const result = await installationRequest(deployment, gateway, 'GET', signal);
          if (result.supportsDrain !== true) throw new Error('The current gateway lacks a protocol drain handler');
        }
      }
      if (requireClients || (previousManifest && previousManifest.protocolVersion !== manifest.protocolVersion)) {
        try {
          await assertClientAvailability({ dataRoot, release: await readJson(join(releaseRoot, 'release.json')), expected: manifest });
        } catch (error) {
          if (requireClients) throw error;
          console.warn(`[Summon Install Warning] Protocol version changed (${previousManifest.protocolVersion} -> ${manifest.protocolVersion}) without all client packages published: ${error.message}`);
        }
      }
      await stageRelease(releaseRoot, destination, manifest, onCopyProgress);
      signal?.throwIfAborted();
      state = await writeInstallationState(dataRoot, { schemaVersion: 1, phase: 'prepared', migration_id: randomUUID(),
        target_build: manifest.buildId, target_format: manifest.dataFormat, release_root: destination, previous_release: deployment?.releaseRoot ?? null,
        previousIntent: deployment?.runIntent ?? 'running', source_root: sourceRoot ?? deployment?.sourceRoot ?? null });
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    } else if (state.target_build !== manifest.buildId || resolve(state.release_root) !== destination) {
      if (!replacePending) throw new Error(`Continue installation ${state.target_build} with its staged release, or use --replace-pending with a repaired build`);
      const previousManifest = state.previous_release && await candidate(state.previous_release);
      if (requireClients || (previousManifest && previousManifest.protocolVersion !== manifest.protocolVersion)) {
        try {
          await assertClientAvailability({ dataRoot, release: await readJson(join(releaseRoot, 'release.json')), expected: manifest });
        } catch (error) {
          if (requireClients) throw error;
          console.warn(`[Summon Install Warning] Protocol version changed (${previousManifest.protocolVersion} -> ${manifest.protocolVersion}) without all client packages published: ${error.message}`);
        }
      }
      await stageRelease(releaseRoot, destination, manifest, onCopyProgress);
      signal?.throwIfAborted();
      state = await writeInstallationState(dataRoot, { ...state, target_build: manifest.buildId,
        target_format: manifest.dataFormat, release_root: destination, phase: state.phase === 'data_ready' ? 'converting' : state.phase });
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    }

    const previous = state.previous_release ? { ...deployment, dataRoot, releaseRoot: state.previous_release } : null;
    const owner = previous && currentWriters(previous);
    if (state.phase === 'prepared') state = await enterDrain({ dataRoot, state, previous, owner });
    if (state.phase === 'draining') {
      state = await finishDrain({ dataRoot, state, previous, owner, onProgress, timeoutMs: drainTimeoutMs, signal });
      signal?.throwIfAborted();
      state = await advanceInstallation(dataRoot, state, 'converting');
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    }
    if (state.phase === 'converting') {
      await owner?.assertStopped({ drain: state.drain });
      const current = deployment || createDeployment({ dataRoot, releaseRoot: destination, defaultCwd, port });
      const localDirectory = join(dataRoot, 'workspace');
      if (!deployment && current.defaultCwd === localDirectory) await mkdir(localDirectory, { recursive: true });
      await stageConfiguration({ dataRoot, state, deployment: current, publicOrigin });
      state = await advanceInstallation(dataRoot, state, 'data_ready');
    }
    const selection = { schemaVersion: 1, releaseRoot: destination, buildId: manifest.buildId, dataRoot,
      selectedAt: state.selected_at || new Date().toISOString() };
    if (state.phase === 'data_ready') {
      await owner?.assertStopped({ drain: state.drain });
      const next = await readJson(join(dataRoot, 'config', `deployment.${state.migration_id}.json`));
      await writeJson(deploymentPath(dataRoot), next);
      for (const name of launchers) await installLauncher(join(destination, name), join(appRoot, name));
      await writeJson(join(appRoot, 'current.json'), selection);
      state = await advanceInstallation(dataRoot, state, 'runtime_ready', { selected_at: selection.selectedAt });
      onProgress?.({ phase: state.phase, buildId: manifest.buildId });
    }
    signal?.throwIfAborted();
    const activeConfig = await readJson(deploymentPath(dataRoot));
    const runtimeState = await startSelected(activeConfig, appRoot, state.previousIntent, resumeRuntime);
    try {
      await cleanReleases({ appRoot, sourceRoot: state.source_root, destination });
      await unlink(join(dataRoot, 'config', `deployment.${state.migration_id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) {
      return { ...selection, sourceCommit: manifest.sourceCommit, runtimeState, cleanupPending: error.message };
    }
    await writeInstallationState(dataRoot, { schemaVersion: 1, phase: 'done', target_build: manifest.buildId,
      target_format: manifest.dataFormat, release_root: destination });
    return { ...selection, sourceCommit: manifest.sourceCommit, runtimeState };
  } finally { await ownership.close(); }
}

export async function runInstallation(options) {
  const controller = new AbortController();
  const abort = () => controller.abort(Object.assign(new Error('Installation paused. Run the same release command to resume.'), { code: 'INSTALLATION_INTERRUPTED' }));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try { return await installRelease({ ...options, signal: controller.signal }); }
  catch (error) { controller.signal.throwIfAborted(); throw error; }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  runInstallation({ releaseRoot: options['release-root'], appRoot: options['app-root'], dataRoot: options['data-root'],
    sourceRoot: options['source-root'], defaultCwd: options.cwd, publicOrigin: options['public-origin'], port: options.port,
    replacePending: options['replace-pending'] === true,
    requireClients: options['require-clients'] === true,
    drainTimeoutMs: Number(options['drain-timeout-ms']),
    onProgress: result => console.log(JSON.stringify(result)),
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
