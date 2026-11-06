import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedBinary, safeEnvironment } from './auxiliaries.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

const target = new URL(process.env.SUMMON_WEB_URL);
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('远程桥需要本机工作区地址。');
const file = process.argv[2] || installedBinary('cloudflared');
if (!file) {
  process.send?.({ type: 'remote-error', message: '未找到 cloudflared，请由 Pi 安装后继续，或传入可执行文件路径。' });
  process.exitCode = 1;
} else {
  const config = join(process.cwd(), 'quick-tunnel.yml');
  await writeFile(config, '', { mode: 0o600 });
  const child = spawn(file, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', target.href], {
    env: safeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let reported = false, registered = false, origin, text = '';
  const read = chunk => {
    text = (text + chunk.toString()).slice(-16384);
    origin ||= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
    registered ||= /Registered tunnel connection/i.test(text);
    if (origin && registered && !reported) { reported = true; process.send?.({ type: 'remote-ready', origin }); }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.once('error', error => { process.send?.({ type: 'remote-error', message: error.message }); process.exitCode = 1; });
  child.once('exit', () => process.exit(0));
  process.on('message', async message => { if (message?.type === 'shutdown') await terminateTree(child); });
  process.once('disconnect', () => { void terminateTree(child); });
}
