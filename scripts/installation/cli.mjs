#!/usr/bin/env node
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { parseArgs, readJson } from '../build/files.mjs';
import { deploymentPath, startSystem, stopSystem, inspectService } from './system.mjs';
import { assertInstallationWritable, dataFormat, readInstallationState } from './installation-state.mjs';
import { watchSystem } from './watchdog.mjs';

const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function main(args = process.argv.slice(2)) {
  const { options, positional } = parseArgs(args), command = positional[0] || 'help';
  if (command === 'help') { console.log('Summon Bot: start [--foreground] [--respect-intent] | status | stop; --data-root PATH --release-root PATH'); return; }
  const dataRoot = resolve(options['data-root'] || process.env.SUMMON_DATA_ROOT || join(installedRoot, '../Relay-Bot-data'));
  if (!existsSync(deploymentPath(dataRoot))) throw new Error('Install a Summon Bot release before using its launcher');
  const config = await readJson(deploymentPath(dataRoot));
  const releaseRoot = options['release-root'] || process.env.SUMMON_RELEASE_ROOT || config.releaseRoot;
  let result;
  if (command === 'status') {
    const installation = await readInstallationState(dataRoot);
    if (installation && !['runtime_ready', 'done'].includes(installation.phase)) {
      result = { state: 'updating', phase: installation.phase, buildId: installation.target_build, drain: installation.drain?.active };
    } else {
      if (config.dataFormat !== dataFormat) throw new Error('Query status with the selected legacy release launcher during the transition');
      result = { web: await inspectService(config, 'web'), gateway: await inspectService(config, 'gateway') };
    }
  }
  else if (command === 'stop') { await assertInstallationWritable(dataRoot, releaseRoot); result = await stopSystem(config); }
  else if (command === 'start') {
    await assertInstallationWritable(dataRoot, releaseRoot);
    if (options.foreground) return watchSystem(config, { respectIntent: Boolean(options['respect-intent']) });
    result = await startSystem(config, { foreground: Boolean(options.foreground), respectIntent: Boolean(options['respect-intent']) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
