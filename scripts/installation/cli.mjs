#!/usr/bin/env node
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { parseArgs, readJson } from '../build/files.mjs';
import { initializeDeployment, deploymentPath, startSystem, stopSystem, inspectService } from './system.mjs';
import { watchSystem } from './watchdog.mjs';

const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function main(args = process.argv.slice(2)) {
  const { options, positional } = parseArgs(args), command = positional[0] || 'help';
  if (command === 'help') { console.log('Relay: init | start [--foreground] [--respect-intent] | dev | status | stop; --data-root PATH --release-root PATH --cwd PATH'); return; }
  const dataRoot = resolve(options['data-root'] || process.env.RELAY_DATA_ROOT || join(installedRoot, '../Relay-Bot-data'));
  let releaseRoot = options['release-root'] || process.env.RELAY_RELEASE_ROOT;
  if (!releaseRoot) {
    if (command === 'dev' || existsSync(join(installedRoot, 'release-manifest.json'))) releaseRoot = installedRoot;
    else if (existsSync(deploymentPath(dataRoot))) releaseRoot = (await readJson(deploymentPath(dataRoot))).releaseRoot;
    else throw new Error('Provide --release-root for first installation, or use dev');
  }
  const initialized = await initializeDeployment({ dataRoot, releaseRoot, defaultCwd: options.cwd, publicOrigin: options['public-origin'] || '', port: options.port ?? 8787 });
  const config = initialized.config;
  let result;
  if (command === 'init') result = { created: initialized.created, configPath: initialized.configPath };
  else if (command === 'status') result = { web: await inspectService(config, 'web'), gateway: await inspectService(config, 'gateway') };
  else if (command === 'stop') result = await stopSystem(config);
  else if (command === 'start' || command === 'dev') {
    if (options.foreground) return watchSystem(config, { respectIntent: Boolean(options['respect-intent']) });
    result = await startSystem(config, { foreground: Boolean(options.foreground), respectIntent: Boolean(options['respect-intent']) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
