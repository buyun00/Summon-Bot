import { spawn } from 'node:child_process';
import { join } from 'node:path';

export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)/i.test(key) &&
    !/^(?:AWS_|AZURE_|GOOGLE_|GITHUB_|SSH_|GIT_ASKPASS$|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONSTARTUP$|NPM_CONFIG_USERCONFIG$)/i.test(key)));
}

export async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolveDone => {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolveDone(); });
      killer.once('close', resolveDone);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
