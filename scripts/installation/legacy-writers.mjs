import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJson, within } from '../build/files.mjs';
import { serviceRunPath } from './system.mjs';

const run = promisify(execFile);
const readOptional = async path => {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const stateError = (message, code = 'INSTALLATION_ACTIVE_WRITER') => Object.assign(new Error(message), { code });

export const firstCutoverPath = dataRoot => join(dataRoot, 'config', 'first_cutover_104.json');

export async function readLegacyHandoff(config) {
  const marker = await readOptional(firstCutoverPath(config.dataRoot));
  if (!marker || !['writers_stopped', 'handoff_selected'].includes(marker.phase) ||
      typeof marker.handoff_release !== 'string' || relative(config.releaseRoot, marker.handoff_release) ||
      typeof marker.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(marker.id) || !Array.isArray(marker.started_calls)) {
    throw stateError('The running legacy release has no matching first-cutover ownership record', 'INSTALLATION_DRAIN_UNAVAILABLE');
  }
  return marker;
}

// The installed 0.3.100 uses a different lock naming scheme. For this transition,
// identify its gateway by the live authenticated control interface and its local
// writer processes by their actual release entry / instance paths.
export function legacyWriters(config, appRoot) {
  if (process.platform !== 'win32') throw stateError('The one-time legacy cutover is for the existing Windows installation');
  const dataRoot = resolve(config.dataRoot), releaseRoot = resolve(config.releaseRoot);
  if (!within(join(appRoot, 'releases'), releaseRoot)) throw stateError('Invalid installed release path');
  async function processes() {
    const roots = [releaseRoot, join(dataRoot, 'bots'), join(dataRoot, 'capabilities'), join(appRoot, 'Start.ps1'),
      join(appRoot, 'Start-Hidden.vbs'), join(dataRoot, 'connectors')];
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = [
      `$summonPaths = @(${roots.map(quote).join(',')})`,
      "$summonWriters = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'nodejs.exe' OR Name = 'cloudflared.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'wscript.exe' OR Name = 'cscript.exe'\" | ForEach-Object {",
      "  $summonCommand = $_.CommandLine",
      "  if ($summonCommand -and $_.ProcessId -ne $PID) {",
      "    $summonCommand = $summonCommand.Replace('/', '\\')",
      "    foreach ($summonPath in $summonPaths) {",
      "      if ($summonCommand.IndexOf($summonPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {",
      '        [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name }; break',
      '      }',
      '    }',
      '  }',
      '}); ConvertTo-Json -InputObject $summonWriters -Compress',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 });
    return JSON.parse(stdout).filter(process => process.pid > 0);
  }
  async function gateway() {
    const marker = await readOptional(serviceRunPath(dataRoot, 'gateway'));
    if (!marker?.controlUrl || !['127.0.0.1', '[::1]'].includes(new URL(marker.controlUrl).hostname)) {
      if (!(await processes()).length) return { state: 'stopped' };
      throw stateError('Old gateway control address is unavailable; previous writer state is uncertain');
    }
    try {
      const response = await fetch(new URL('/health', marker.controlUrl),
        { headers: { Authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const actual = await response.json();
      if (actual.type !== 'gateway' || actual.bootId !== marker.bootId || actual.pid !== marker.pid ||
          relative(releaseRoot, actual.releaseRoot)) throw new Error('Gateway owner changed');
      return actual;
    } catch (error) {
      if (!(await processes()).some(entry => entry.pid === marker.pid)) return { state: 'stopped' };
      throw stateError(`Old gateway control refused identification (${error.message})`);
    }
  }
  return {
    legacy: true,
    gateway,
    async stop() {
      // Only the independently implemented old-protocol controller can declare
      // its Bot, capability and detached native writers safe to stop.
      const entry = join(releaseRoot, 'scripts', 'installation', 'finish-installation.mjs');
      const runtime = join(releaseRoot, 'runtime', 'node.exe');
      try { await readFile(entry); }
      catch (error) { if (error.code === 'ENOENT') throw stateError('The old protocol handoff shutdown entry is missing'); throw error; }
      await run(runtime, [entry, '--data-root', dataRoot], { windowsHide: true });
    },
    async assertStopped() {
      const active = await processes();
      if (active.length) throw stateError(`The old deployment still owns ${active.map(entry => `${entry.name} PID ${entry.pid}`).join(', ')}`);
    },
  };
}
