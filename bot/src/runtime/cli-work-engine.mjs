import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { cleanEnvironment, terminateTree } from './process-tools.mjs';
import { localGrokAuthPath, localGrokLogin } from '../agent/connections.mjs';
import { cliExecutorBridge, cliExecutorNames, requireCliExecutor } from '../capabilities/executor-connections.mjs';
import { workInput } from '../capabilities/task-policy.mjs';

const windows = process.platform === 'win32';
const workError = (message, code) => Object.assign(new Error(message), { code, status: 409, expose: true });
const credentialNames = id => id === 'codex-cli' ? [] : id === 'grok' ? ['XAI_API_KEY'] : ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

async function executableFor(id, bridgePath) {
  if (bridgePath) {
    if (!isAbsolute(bridgePath) || !(await stat(bridgePath)).isFile()) throw workError('工作引擎的桥接脚本不可用，请让主 Bot 修复。', 'WORK_ENGINE_BRIDGE_MISSING');
    await access(bridgePath, constants.R_OK);
    return { file: process.execPath, prefix: [bridgePath] };
  }
  const home = homedir(), binary = (id === 'codex-cli' ? 'codex' : id === 'grok' ? 'grok' : 'claude') + (windows ? '.exe' : '');
  const pathFolders = (process.env.PATH || '').split(delimiter).map(folder => folder.replace(/^"|"$/g, '')).filter(isAbsolute);
  const folders = id === 'grok' ? [join(process.env.GROK_HOME || join(home, '.grok'), 'bin')]
    : [join(home, '.local', 'bin'), ...(id === 'claude-code' && windows && process.env.APPDATA
      ? [join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin')] : [])];
  const candidates = [...folders, ...pathFolders].map(folder => join(folder, binary));
  if (id === 'codex-cli') {
    const platform = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[process.platform];
    const architecture = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    const target = architecture + '-' + platform;
    const packageName = '@openai/codex-' + process.platform + '-' + process.arch;
    const npmFolders = [...(windows && process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []), ...pathFolders];
    for (const folder of npmFolders) {
      for (const root of [join(folder, 'node_modules', '@openai', 'codex'), join(folder, '..', 'lib', 'node_modules', '@openai', 'codex')]) {
        try {
          await access(join(root, 'package.json'));
          const require = createRequire(join(root, 'package.json'));
          const vendor = join(dirname(require.resolve(packageName + '/package.json')), 'vendor');
          candidates.push(join(vendor, target, 'bin', binary));
        } catch {}
        candidates.push(join(root, 'vendor', target, 'bin', binary));
      }
    }
    if (process.platform === 'darwin') {
      candidates.push('/Applications/Codex.app/Contents/Resources/codex', join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
    }
    if (windows && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', binary));
  }
  for (const file of new Set(candidates)) {
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  throw workError('部署机没有找到 ' + cliExecutorNames[id] + '，请安装后重试。', 'WORK_ENGINE_MISSING');
}

async function runCli(file, args, { id, cwd, input = '', signal, timeout, onLine, captureStderr = false }) {
  signal?.throwIfAborted();
  const env = cleanEnvironment();
  for (const key of credentialNames(id)) if (process.env[key]) env[key] = process.env[key];
  const command = typeof file === 'string' ? { file, prefix: [] } : file;
  const child = spawn(command.file, [...command.prefix, ...args], { cwd, env, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'] });
  const chunks = [];
  let bytes = 0, pending = '', failure, killing;
  const stop = error => {
    failure ||= error;
    killing ||= terminateTree(child);
  };
  const abort = () => stop(signal.reason || new Error('工作已取消。'));
  const timer = setTimeout(() => stop(workError('工作引擎执行超时。', 'WORK_ENGINE_TIMEOUT')), timeout);
  signal?.addEventListener('abort', abort, { once: true });
  const capture = chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) stop(workError('工作引擎的返回内容过长。', 'WORK_ENGINE_OUTPUT_LIMIT'));
    else chunks.push(chunk);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    capture(chunk);
    if (!onLine || failure) return;
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    try { for (const line of lines) if (line.trim()) onLine(line); }
    catch (error) { stop(error); }
  });
  if (captureStderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', capture); }
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      if (signal?.aborted) abort();
    });
    if (onLine && pending.trim() && !failure) {
      try { onLine(pending); } catch (error) { stop(error); }
    }
    if (killing) await killing;
    if (failure) throw failure;
    return { exitCode, output: chunks.join('').trim() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function confirmWorkCli(id, { bridgePath, signal } = {}) {
  const file = await executableFor(id, bridgePath);
  const run = (args, options) => runCli(file, args, { id, cwd: homedir(), timeout: 15000, signal, ...options });
  if (id === 'codex-cli') {
    const result = await run(['login', 'status'], { captureStderr: true });
    if (result.exitCode !== 0 || !/\bChatGPT\b/i.test(result.output)) {
      throw workError('请先在这台电脑运行 codex login，使用 ChatGPT 订阅登录后重试。', 'WORK_ENGINE_LOGIN_REQUIRED');
    }
  } else if (id === 'claude-code') {
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
  return file;
}

async function runWorkCli(id, file, sessionId, resume, prompt, config, signal, onSession) {
  const name = cliExecutorNames[id];
  const run = (args, input) => runCli(file, args, { id, cwd: config.workspace, input, signal, timeout: 30 * 60 * 1000 });
  if (id === 'codex-cli') {
    let threadId, completed = false, failed = false, content = '';
    const onLine = line => {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') {
        if (typeof event.thread_id !== 'string' || !event.thread_id || sessionId && event.thread_id !== sessionId || threadId && event.thread_id !== threadId) {
          throw workError('Codex 返回的工作会话与当前委托不一致。', 'WORK_ENGINE_SESSION_MISMATCH');
        }
        if (!threadId) { threadId = event.thread_id; onSession(threadId); }
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') content = event.item.text.trim();
      if (event.type === 'turn.completed') completed = true;
      if (['turn.failed', 'error'].includes(event.type)) failed = true;
    };
    const args = ['exec', ...(resume ? ['resume', sessionId] : []), '--json', '--skip-git-repo-check', '-'];
    const result = await runCli(file, args, { id, cwd: config.workspace, input: prompt, signal, onLine, timeout: 30 * 60 * 1000 });
    if (result.exitCode !== 0 || failed || !completed || !threadId || !content) {
      throw workError('Codex 没有返回可确认的执行结果（退出状态 ' + result.exitCode + '）。', 'WORK_ENGINE_FAILED');
    }
    return content;
  }
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
  const bridgePath = cliExecutorBridge(config.model, kind);
  const file = kind === 'codex-cli' ? await confirmWorkCli(kind, { bridgePath }) : await executableFor(kind, bridgePath);
  let sessionId = executor.sessionId || (kind === 'codex-cli' ? null : randomUUID());
  const operation = { kind, sessionId, status: 'running', taskId: task.id, startedAt: new Date().toISOString() };
  const prompt = JSON.stringify({ type: 'work_input', goal: work.goal, requirements: work.requirements,
    input: workInput(services.works.executionInput(task)),
    instruction: '只执行本次委托里明确的步骤。此前的内容作为上下文使用，不重复已完成的操作。完成后给出结果、实际变更与任何无法完成的部分。' });
  signal?.throwIfAborted();
  store.putRecord('work-events', { ...event, cliExecution: operation });
  let content;
  try {
    let result = await runWorkCli(kind, file, sessionId, Boolean(executor.sessionId), prompt, config, signal, id => {
      sessionId = id;
      operation.sessionId = id;
      store.transaction(() => {
        store.putRecord('work-events', { ...store.getRecord('work-events', eventId), cliExecution: operation });
        if (services.works.get(work.id)?.status === 'active') services.works.update(work.id, { executor: { ...executor, sessionId } });
      });
    });
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
