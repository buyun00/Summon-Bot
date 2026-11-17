import { join, resolve } from 'node:path';
import { readJson, writeJson } from '../build/files.mjs';

export const dataFormat = 3;
export const installationStatePath = dataRoot => join(resolve(dataRoot), 'config', 'installation_state.json');
const phases = ['prepared', 'draining', 'converting', 'data_ready', 'runtime_ready', 'done'];
const canStart = new Set(['runtime_ready', 'done']);
const samePath = (left, right) => {
  const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
};

export async function readInstallationState(dataRoot) {
  let state;
  try { state = await readJson(installationStatePath(dataRoot)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (state.schemaVersion !== 1 || !phases.includes(state.phase) || typeof state.target_build !== 'string'
      || !Number.isSafeInteger(state.target_format) || typeof state.release_root !== 'string'
      || (state.phase !== 'done' && typeof state.migration_id !== 'string')) {
    throw new Error('Invalid Summon Bot installation state');
  }
  return state;
}

export async function assertInstallationWritable(dataRoot, releaseRoot) {
  const state = await readInstallationState(dataRoot);
  if (state && (!canStart.has(state.phase) || (releaseRoot && !samePath(releaseRoot, state.release_root)))) {
    const error = new Error(`Summon Bot installation is ${state.phase} for build ${state.target_build}`);
    error.code = 'updating';
    error.status = 503;
    throw error;
  }
  return state;
}

// Only the installer writes the state, under the installation ownership lock.
export async function writeInstallationState(dataRoot, state) {
  await writeJson(installationStatePath(dataRoot), state);
  return state;
}

export async function advanceInstallation(dataRoot, state, phase, facts = {}) {
  if (phases.indexOf(phase) !== phases.indexOf(state.phase) + 1) {
    throw new Error(`Invalid installation transition from ${state.phase} to ${phase}`);
  }
  return writeInstallationState(dataRoot, { ...state, ...facts, phase });
}
