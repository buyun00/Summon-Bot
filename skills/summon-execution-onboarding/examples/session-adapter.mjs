import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { TextDecoder } from 'node:util';

const emit = event => process.stdout.write(JSON.stringify({ summonEvent: event }) + '\n');
const complete = (status, error) => emit({ type: 'outcome', status, error });

// Windows sort.exe accepts input on stdin and reports success with exit 0.
// Adjust the argument mapping, encoding and result parser for the bound program.
const upstream = { args: [], encoding: 'utf-8', timeoutMs: 10_000 };

function run(executable, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, upstream.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, interrupted;
    const collect = (buffers, chunk) => {
      size += chunk.length;
      if (size <= 65_536) buffers.push(chunk);
      else if (!interrupted) {
        interrupted = 'Upstream output exceeded 64 KiB';
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      interrupted = 'Upstream call reached its time limit';
      child.kill('SIGKILL');
    }, upstream.timeoutMs);
    child.once('spawn', () => emit({ type: 'progress', phase: 'started', text: 'Upstream process started' }));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', error => { interrupted ??= `Upstream stdin: ${error.message}`; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, interrupted, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(text);
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  const { value } = await lines[Symbol.asyncIterator]().next();
  const start = JSON.parse(value).summonStart;
  if (typeof start?.executable !== 'string' || typeof start.text !== 'string') {
    complete('not_submitted', 'Expected a summonStart with executable and text');
  } else if (start.sessionId != null) {
    complete('unsupported', 'The bound sort program has no native session to resume');
  } else {
    let result;
    try { result = await run(start.executable, start.text); }
    catch (error) { complete('not_submitted', `Upstream process could not start: ${error.message}`); }
    if (result) {
      const diagnostic = new TextDecoder(upstream.encoding).decode(result.stderr).trim().slice(0, 1500);
      if (result.interrupted || result.signal) {
        complete('unknown', result.interrupted ?? `Upstream terminated by ${result.signal}`);
      } else if (result.code !== 0) {
        complete('failed', `Upstream exited with ${result.code}${diagnostic ? `: ${diagnostic}` : ''}`);
      } else {
        try {
          const text = new TextDecoder(upstream.encoding, { fatal: true }).decode(result.stdout);
          if (text) emit({ type: 'result', text, confirmed: true });
          complete('completed');
        } catch (error) { complete('unknown', `Upstream finished but its result could not be parsed: ${error.message}`); }
      }
    }
  }
} catch (error) {
  complete('not_submitted', `Invalid adapter startup input: ${error.message}`);
} finally {
  lines.close();
}
