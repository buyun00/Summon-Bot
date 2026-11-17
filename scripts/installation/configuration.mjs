import { join } from 'node:path';
import { readJson, writeJson } from '../build/files.mjs';
import { readRemoteAccess, writeRemoteAccess } from './remote-config.mjs';
import { instanceOrigin } from '../../web/backend/origins.mjs';

export async function stageConfiguration({ dataRoot, state, deployment, limits, publicOrigin }) {
  if (state.phase !== 'converting') throw new Error('Installation must prepare configuration before selecting the runtime');
  if (publicOrigin) {
    const origin = instanceOrigin(publicOrigin, { httpsOnly: true });
    const access = await readRemoteAccess(dataRoot).catch(error => {
      console.warn(`Public origin unchanged: cannot read remote-access.json (${error.code || error.name})`);
    });
    if (access && !access.cloudflare) {
      await writeRemoteAccess(dataRoot, { ...access, cloudflare: { origin, owner: 'external' } }).catch(error => {
        console.warn(`Public origin unchanged: cannot write remote-access.json (${error.code || error.name})`);
      });
    }
  }
  const next = { ...deployment, schemaVersion: 4, dataFormat: state.target_format, releaseRoot: state.release_root,
    runIntent: state.previousIntent, limits,
    ...(state.source_root ? { sourceRoot: state.source_root } : {}) };
  await writeJson(join(dataRoot, 'config', `deployment.${state.migration_id}.json`), next);
}
