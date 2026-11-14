import { join } from 'node:path';
import { readJson, writeJson } from '../build/files.mjs';

export async function stageConfiguration({ dataRoot, state, deployment, defaultLimits, publicOrigin }) {
  if (state.phase !== 'converting') throw new Error('Installation must prepare configuration before selecting the runtime');
  if (publicOrigin) {
    const path = join(dataRoot, 'config', 'remote-access.json');
    const access = await readJson(path).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid configured public origin');
    if (!access.cloudflare) await writeJson(path, { ...access, cloudflare: { origin: url.origin, owner: 'external' } });
  }
  const next = { ...deployment, schemaVersion: 4, dataFormat: state.target_format, releaseRoot: state.release_root,
    runIntent: state.previousIntent, limits: { ...defaultLimits, ...deployment.limits },
    ...(state.source_root ? { sourceRoot: state.source_root } : {}) };
  await writeJson(join(dataRoot, 'config', `deployment.${state.migration_id}.json`), next);
}
