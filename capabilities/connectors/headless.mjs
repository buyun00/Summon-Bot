import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { nativeArgs, nativeCommand } from '../services/native-host.mjs';
import { connectorFor, launchArguments } from './registry.mjs';
import { recipeAdapter } from './recipe.mjs';

const emit = (type, data = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...data } }) + '\n');
const append = (before, addition) => (before + addition).slice(-16000);

async function run({ executable, connector, settings, recipe, launchOptions, extraArgs = [], text, sessionId: expectedId }) {
  const adapter = recipe ? recipeAdapter(recipe) : connectorFor(connector);
  if (!adapter?.invocation) throw new Error('The registered CLI connector is unavailable');
  const promptFile = process.argv[2];
  if (promptFile) await writeFile(promptFile, text, { flag: 'wx', mode: 0o600 });
  const { args, stdin, environment } = adapter.invocation({ text, sessionId: expectedId, settings, promptFile });
  const command = nativeCommand(executable, nativeArgs([...args, ...launchArguments(launchOptions, Boolean(expectedId)), ...extraArgs]));
  const child = spawn(command.file, command.args, { ...command.options, env: { ...process.env, ...environment }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  const diagnostics = createInterface({ input: child.stderr, crlfDelay: Infinity });
  diagnostics.on('line', text => {
    if (text.trim()) emit('progress', { text: text.slice(0, 4000), phase: 'stderr' });
  });
  child.stderr.pipe(process.stderr, { end: false });
  let sessionId, finalText = '', deltas = '', reason, error, terminal = false;
  const format = recipe?.output ?? settings.format;
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let drainTimer;
  child.once('exit', () => {
    drainTimer = setTimeout(() => {
      output.close();
      diagnostics.close();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
  });
  function receive(frame) {
    if (!frame || typeof frame !== 'object') return;
    const event = adapter.receive(frame, format);
    if (!event) return;
    if (typeof event.sessionId === 'string' && event.sessionId && event.sessionId !== sessionId) {
      if (sessionId || expectedId && event.sessionId !== expectedId) error = 'The CLI reported a different native session';
      else {
        sessionId = event.sessionId;
        emit('session', { sessionId });
      }
    }
    if (event.boundary) deltas = '';
    if (typeof event.delta === 'string') deltas = append(deltas, event.delta);
    if (typeof event.progress === 'string' && event.progress)
      emit('progress', { text: event.progress.slice(0, 4000), itemId: event.itemId, phase: event.phase });
    for (const tool of event.tools ?? []) {
      emit('tool', Object.fromEntries(Object.entries(tool).filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value.slice(0, 4000)])));
    }
    if (typeof event.text === 'string') finalText = event.text.slice(-16000);
    if (event.terminal) { terminal = true; reason = event.reason; }
    if (event.error) error ||= String(event.error);
  }
  let json = '';
  for await (const line of output) {
    if (format === 'plain') {
      finalText = append(finalText, line + '\n');
      continue;
    }
    if (format === 'json') {
      if (json.length < 2_000_000) json += line.slice(0, 2_000_000 - json.length) + '\n';
      continue;
    }
    if (!line.trimStart().startsWith('{')) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    receive(frame);
  }
  const outcome = await exit;
  clearTimeout(drainTimer);
  if (json) {
    let frame;
    try { frame = JSON.parse(json); }
    catch { error = 'The CLI did not return a readable JSON result'; }
    receive(frame);
  }
  error ||= outcome.error;
  if (!error && outcome.code !== 0) error = `CLI exited with ${outcome.signal || `code ${outcome.code}`}. See stderr for details.`;
  if (!error && format !== 'plain' && (!terminal || !adapter.success(reason)))
    error = terminal ? `The CLI turn ended with ${reason || 'an unspecified reason'}` : 'The CLI did not report a terminal result';
  if (!error && expectedId && sessionId !== expectedId) error = 'The CLI did not confirm the resumed native session';
  const result = (finalText || deltas).trim();
  if (result) emit('result', { text: result, confirmed: !error && terminal });
  emit('outcome', error ? { status: terminal || outcome.code !== 0 ? 'failed' : 'unknown', error: error.slice(0, 4000) } : { status: 'completed' });
  if (error) process.exitCode = 1;
}

try {
  let payload = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) payload += chunk;
  await run(JSON.parse(payload).summonStart);
} catch (error) {
  emit('outcome', { status: 'failed', error: error.message });
  process.exitCode = 1;
}
