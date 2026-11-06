import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { cleanEnvironment, terminateTree } from './process-tools.mjs';
import { localGrokAuthPath, localGrokLogin } from '../agent/connections.mjs';
import { cliExecutorNames, requireCliExecutor } from '../capabilities/executor-connections.mjs';
import { workInput } from '../capabilities/task-policy.mjs';

const windows = process.platform === 'win32';
const workError = (message, code) => Object.assign(new Error(message), { code, status: 409, expose: true });
const credentialNames = id => id === 'grok' ? ['XAI_API_KEY'] : ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

async function executableFor(id) {
  const home = homedir(), binary = (id === 'grok' ? 'grok' : 'claude') + (windows ? '.exe' : '');
  const pathFolders = (process.env.PATH || '').split(delimiter).map(folder => folder.replace(/^"|"$/g, '')).filter(isAbsolute);
  const folders = id === 'grok' ? [join(process.env.GROK_HOME || join(home, '.grok'), 'bin')]
    : [join(home, '.local', 'bin'), ...(windows && process.env.APPDATA
      ? [join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin')] : [])];
  for (const folder of [...folders, ...pathFolders]) {
    const file = join(folder, binary);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  throw workError('部署机没有找到 ' + cliExecutorNames[id] + '，请安装后重试。', 'WORK_ENGINE_MISSING');
}

async function runCli(file, args, { id, cwd, input = '', signal, timeout }) {
  signal?.throwIfAborted();
  const env = cleanEnvironment();
  for (const key of credentialNames(id)) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(file, args, { cwd, env, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks = [];
  let bytes = 0, failure, killing;
  const stop = error => {
    failure ||= error;
    killing ||= terminateTree(child);
  };
  const abort = () => stop(signal.reason || new Error('工作已取消。'));
  const timer = setTimeout(() => stop(workError('工作引擎执行超时。', 'WORK_ENGINE_TIMEOUT')), timeout);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) stop(workError('工作引擎的返回内容过长。', 'WORK_ENGINE_OUTPUT_LIMIT'));
    else chunks.push(chunk);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      if (signal?.aborted) abort();
    });
    if (killing) await killing;
    if (failure) throw failure;
    return { exitCode, output: Buffer.concat(chunks).toString('utf8').trim() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function confirmWorkCli(id) {
  const file = await executableFor(id);
  const run = args => runCli(file, args, { id, cwd: homedir(), timeout: 15000 });
  if (id === 'claude-code') {
    const result = await run(['auth', 'status', '--json']);
    if (result.exitCode !== 0) throw workError('请先在部署机运行 claude auth login 完成登录。', 'WORK_ENGINE_LOGIN_REQUIRED');
  } else {
    const help = await run(['--no-auto-update', '--help']);
    if (help.exitCode !== 0 || !help.output.includes('--prompt-file')) {
      throw workError('部署机上的 Grok Build 需要更新到支持非交互执行的版本。', 'WORK_ENGINE_UPDATE_REQUIRED');
    }
    if (!process.env.XAI_API_KEY) {
      const file = process.env.GROK_AUTH_PATH || (process.env.GROK_HOME ? join(process.env.GROK_HOME, 'auth.json') : localGrokAuthPath());
      try { localGrokLogin(JSON.parse(await readFile(file, 'utf8'))); }
      catch { throw workError('请先在部署机运行 grok login 完成登录。', 'WORK_ENGINE_LOGIN_REQUIRED'); }
    }
  }
}

async function runWorkCli(id, file, sessionId, resume, prompt, config, signal) {
  const name = cliExecutorNames[id];
  const run = (args, input) => runCli(file, args, { id, cwd: config.workspace, input, signal, timeout: 30 * 60 * 1000 });
  const session = [resume ? '--resume' : '--session-id', sessionId];
  if (id === 'claude-code') {
    const result = await run(['-p', '--output-format', 'json', '--permission-mode', 'dontAsk',
      '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...session], prompt);
    let response;
    try { response = JSON.parse(result.output); } catch {}
    if (result.exitCode !== 0 || response?.is_error || response?.session_id !== sessionId || typeof response?.result !== 'string' || !response.result.trim()) {
      throw workError(name + ' 没有返回可确认的执行结果（退出状态 ' + result.exitCode + '）。', 'WORK_ENGINE_FAILED');
    }
    return response.result.trim();
  }

  const directory = join(config.dataDir, 'tmp');
  await mkdir(directory, { recursive: true });
  const promptFile = join(directory, 'grok-work-' + randomUUID() + '.txt');
  await writeFile(promptFile, prompt, { mode: 0o600, flag: 'wx' });
  try {
    const result = await run(['--no-auto-update', '--permission-mode', 'dontAsk', '--output-format', 'plain',
      ...session, '--prompt-file', promptFile]);
    if (result.exitCode !== 0 || !result.output) {
      throw workError(name + ' 没有返回可确认的执行结果（退出状态 ' + result.exitCode + '）。', 'WORK_ENGINE_FAILED');
    }
    return result.output;
  } finally {
    await unlink(promptFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function executeCliWork({ store, services, config, task, signal, clean }) {
  const work = services.works.get(task.workId), executor = services.works.executor(work), kind = executor.kind;
  requireCliExecutor(config.model, kind);
  const execution = services.works.execution(task);
  if (!execution.authorization?.source) throw workError('这一步缺少可确认的委托来源。', 'WORK_ENGINE_NO_SOURCE');
  const eventId = task.metadata?.workEventId || execution.executionEventId || work.id + ':task:' + task.id;
  const event = store.getRecord('work-events', eventId) || { id: eventId, workId: work.id, content: task.input };
  if (event.cliExecution?.status === 'completed') return { executor: kind, content: event.cliExecution.content };
  if (event.cliExecution) throw workError('上一次执行已有记录。请根据结果或现有工作状态给出下一步。', 'WORK_ENGINE_OUTCOME_UNKNOWN');
  const file = await executableFor(kind);
  const sessionId = executor.sessionId || randomUUID();
  const operation = { kind, sessionId, status: 'running', taskId: task.id, startedAt: new Date().toISOString() };
  const prompt = JSON.stringify({ type: 'work_input', goal: work.goal, requirements: work.requirements,
    input: workInput(services.works.executionInput(task)),
    instruction: '只执行本次委托里明确的步骤。此前的内容作为上下文使用，不重复已完成的操作。完成后给出结果、实际变更与任何无法完成的部分。' });
  signal?.throwIfAborted();
  store.putRecord('work-events', { ...event, cliExecution: operation });
  let content;
  try {
    let result = await runWorkCli(kind, file, sessionId, Boolean(executor.sessionId), prompt, config, signal);
    for (const key of credentialNames(kind)) {
      const secret = process.env[key];
      if (secret?.length >= 8) result = result.replaceAll(secret, '[redacted]');
    }
    content = clean(result.replace(/\b(?:xai-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[redacted]'));
    signal?.throwIfAborted();
  } catch (error) {
    store.putRecord('work-events', { ...store.getRecord('work-events', eventId),
      cliExecution: { ...operation, status: signal?.aborted ? 'interrupted' : 'failed', code: error.code || null } });
    throw error;
  }
  store.transaction(() => {
    store.putRecord('work-events', { ...store.getRecord('work-events', eventId),
      cliExecution: { ...operation, status: 'completed', content, finishedAt: new Date().toISOString() } });
    if (services.works.get(work.id)?.status === 'active') {
      services.works.update(work.id, { executor: { ...executor, sessionId }, status: 'completed', progress: content.slice(0, 1200) });
    }
  });
  return { executor: kind, content };
}
