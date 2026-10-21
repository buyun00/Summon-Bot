#!/usr/bin/env node
import { startBot, loadBotConfig } from '../src/index.mjs';

const args = process.argv.slice(2), configAt = args.indexOf('--config');
const notify = value => { process.stdout.write(`${JSON.stringify(value)}\n`); if (process.connected) process.send(value, () => {}); };
try {
  if (configAt < 0 || !args[configAt + 1]) throw new Error('Usage: relay-bot --config /absolute/path/config.json');
  const bot = await startBot(loadBotConfig(args[configAt + 1]));
  let closing;
  const stop = () => closing ||= bot.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  // bot.stopped is durable before final file/SQLite/identity cleanup completes.
  // Reuse the close promise instead of exiting while its I/O is still pending.
  bot.subscribe(event => { if (event.type === 'bot.stopped') setImmediate(stop); });
  notify({ type: 'ready', ...bot.health() });
} catch (error) {
  notify({ type: 'error', code: error.code, message: error.message, existing: error.existing }); process.exitCode = 1;
}
