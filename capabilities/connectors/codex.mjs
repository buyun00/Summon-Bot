import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const codexBridge = fileURLToPath(new URL('../codex/app-server.mjs', import.meta.url));

export const codex = {
  id: 'codex', name: 'Codex', command: 'codex', kind: 'codex',
  guide: new URL('./codex.md', import.meta.url), source: new URL('../codex/app-server.mjs', import.meta.url),
  documentation: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md',
  protocolOptions: ['--listen', '--stdio', '--print-startup-config', '--startup-sign-out', '--startup-client-info'],
  helpTopic: 'app-server',
  async candidates(roots) {
    if (process.platform !== 'win32') return [join(homedir(), '.local', 'bin', 'codex')];
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const desktop = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const desktopBuilds = await readdir(desktop, { withFileTypes: true }).catch(() => []);
    return [...roots.map(root => join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      `codex-win32-${process.arch}`, 'vendor', `${architecture}-pc-windows-msvc`, 'bin', 'codex.exe')),
    ...desktopBuilds.filter(item => item.isDirectory()).map(item => join(desktop, item.name, 'codex.exe'))];
  },
  settings(_help, appHelp) {
    if (appHelp?.includes('--stdio')) return { stdio: 'flag' };
    if (appHelp?.includes('--listen')) return { stdio: 'listen' };
    return { stdio: 'default' };
  },
  config: settings => ({ app_server_stdio: settings.stdio }),
};

export function appServerArgs(mode = 'flag') {
  if (mode === 'listen') return ['app-server', '--listen', 'stdio://'];
  return mode === 'default' ? ['app-server'] : ['app-server', '--stdio'];
}
