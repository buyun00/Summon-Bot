import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const provider = process.argv[2], args = process.argv.slice(3);
const read = name => JSON.parse(readFileSync(join(root, name + '.json'), 'utf8'));
const write = (name, value) => writeFileSync(join(root, name + '.json'), JSON.stringify(value));
appendFileSync(join(root, 'commands.jsonl'), JSON.stringify({ provider, args }) + '\n');
if (provider === 'tailscale') {
  if (args[0] === 'status') console.log(JSON.stringify(read('ts-status')));
  else if (args[0] === 'serve' && args[1] === 'status') console.log(JSON.stringify(read('ts-serve')));
  else if (args[0] === 'serve') {
    const mode = read('ts-mode').mode;
    if (args.at(-1) === 'off') { write('ts-serve', read('ts-unrelated')); console.log('removed selected mapping'); }
    else if (mode === 'authorize') { console.error('Enable HTTPS at https://login.tailscale.com/admin/dns'); process.exitCode = 1; }
    else if (mode === 'fail') { console.error('fixture network unavailable'); process.exitCode = 1; }
    else { write('ts-serve', read('ts-after')); console.log('Serve configured'); }
  } else process.exitCode = 1;
} else if (provider === 'cloudflared') {
  const metrics = args[args.indexOf('--metrics') + 1];
  const port = Number(metrics.split(':').at(-1));
  const server = createServer((req, res) => {
    const ready = read('cf-mode').mode === 'ready';
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready }));
  });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
