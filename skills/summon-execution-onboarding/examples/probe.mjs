import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Add upstream flags here if the two probe commands need different prefixes.
const prefixes = { version: [], help: [] };
try {
  const { value } = await lines[Symbol.asyncIterator]().next();
  const probe = JSON.parse(value).summonProbe;
  const { executable, purpose, args } = probe;
  if (typeof executable !== 'string' || !['version', 'help'].includes(purpose) ||
      !Array.isArray(args) || !args.every(argument => typeof argument === 'string')) {
    throw new Error('Expected a summonProbe with an executable, version or help, and an argument array');
  }
  const upstream = [...prefixes[purpose], ...args];
  const child = spawn(executable, upstream, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (signal) {
    process.stderr.write(`Upstream terminated by ${signal}\n`);
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  lines.close();
}
