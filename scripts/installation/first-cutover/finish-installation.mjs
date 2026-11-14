import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

async function finish() {
  const { parseArgs, readJson } = await import('../build/files.mjs');
  const { deploymentPath, inspectService, stopService } = await import('./system.mjs');
  const { options } = parseArgs(process.argv.slice(2));
  const dataRoot = resolve(options['data-root']);
  const config = await readJson(deploymentPath(dataRoot));
  const releaseRoot = fileURLToPath(new URL('../../', import.meta.url));
  const state = await readJson(join(dataRoot, 'config', 'installation_state.json'));
  if (resolve(config.releaseRoot) !== resolve(releaseRoot) || resolve(state.previous_release) !== resolve(releaseRoot) ||
      state.phase !== 'draining' || state.intake_closed !== true || state.drain?.intake_closed !== true || state.drain?.ready !== true) {
    throw new Error('Installation cutover does not authorize this gateway shutdown');
  }
  // The handoff launch leaves the deployment's run intent stopped. The main
  // installer applies the original intent after selecting the new format.
  if (config.runIntent !== 'stopped') throw new Error('The legacy watchdog is still authorized to restart this deployment');
  for (const service of ['web', 'gateway', 'cloudflared', 'remote-bridge']) {
    let observed = await inspectService(config, service);
    while (observed.state === 'stopping') {
      await pause(1000);
      observed = await inspectService(config, service);
    }
    if (observed.state !== 'stopped') await stopService(config, service);
  }
}

finish().catch(error => { console.error(error.message); process.exitCode = 1; });
