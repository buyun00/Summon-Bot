import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { AppTools, matchesPermissionDefault } from './app-tools.js';
import { DesktopIpc } from './desktop-ipc.js';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { createServer } from './server.js';
import { Webhook, webhookConfig } from './webhook.js';

const config = loadConfig();
config.webhook = webhookConfig(config.webhook);
const store = new Store(path.join(config.dataDir, 'bridge.sqlite'), config.eventRetention);
const tools = new AppTools(config, { permissionCandidates: expected => broker.permissionCandidates(value => matchesPermissionDefault(value, expected)) });
const ipc = new DesktopIpc(config);
const broker = new Broker(config, tools, ipc, store);
const webhook = new Webhook(broker, config.webhook, config.dataDir);
const openapi = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi.json'), 'utf8'));
const server = createServer({ config, tools, broker, store, openapi });
server.on('error', error => { console.error(error.message); webhook.close(); broker.close(); store.close(); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ service: 'codex-desktop-api', version: '0.1.0', url: `http://${config.host}:${config.port}`, pid: process.pid }));
  broker.start();
  if (process.connected) process.send({ type: 'ready' }, () => {});
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  broker.close(); await webhook.close(); await server.stop();
  // Pending upstream requests settle before closing their operation journal.
  const deadline = Date.now() + 1500;
  while (broker.polling && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  store.close();
  if (process.connected) process.disconnect();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('message', message => { if (message?.type === 'shutdown') void stop(); });
process.on('disconnect', () => void stop());
