import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPathAccess, pathWithin } from '../../bot/src/capabilities/file-policy.mjs';
import { attachWindowsJob, cleanEnvironment, terminateTree } from '../../bot/src/runtime/process-tools.mjs';
import { botRootDir, protectedRuntimeDirs, validateBotRelPath } from '../bot-management/folders.mjs';
import { engineRootDir, extraToolDirs, validateEngineRelPath } from '../engines/service.mjs';
import { capabilitiesDataRoot } from '../skills/service.mjs';
import { keyOf, reject } from '../platform/contract.mjs';
import { pipeNativeText } from './windows-native-text.mjs';

export const operationRecords = 'session-operations';
const executionRecords = 'platform-sessions';
const windows = process.platform === 'win32';
const programRoot = fileURLToPath(new URL('../../', import.meta.url));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validText = (v, max = 32_768) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const settled = s => ['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'not_submitted'].includes(s);

function buildSafeEnv(rawEnv, optionalEnv = null, dataRoot = null) {
  const env = cleanEnvironment();
  for (const key of ['CODEX_HOME', 'GROK_HOME', 'GROK_AUTH_PATH', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (dataRoot) {
    env.SUMMON_CAPABILITIES_DIR = capabilitiesDataRoot(dataRoot);
  }
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const existing = (env[pathKey] || '').split(delimiter).filter(Boolean);
  env[pathKey] = [...new Set([...existing, ...extraToolDirs()])].join(delimiter);

  const secrets = [];
  if (Array.isArray(optionalEnv)) {
    for (const rawName of optionalEnv) {
      const name = String(rawName || '').trim();
      if (!envNameRe.test(name)) continue;
      const val = process.env[name];
      if (val !== undefined) {
        env[name] = val;
        if (val) secrets.push(val);
      }
    }
  }
  if (rawEnv == null) return { env, secrets };
  const pairs = Array.isArray(rawEnv)
    ? rawEnv.map(name => [String(name || '').trim(), String(name || '').trim()])
    : plain(rawEnv)
      ? Object.entries(rawEnv).map(([k, v]) => [k, typeof v === 'string' ? v : v?.env])
      : reject('invalid_arguments', 'env must be an array of env names or { KEY: "VAR" } map');
  for (const [key, ref] of pairs) {
    if (!envNameRe.test(key) || typeof ref !== 'string' || !envNameRe.test(ref)) {
      reject('invalid_arguments', `Invalid environment variable name: ${key}`);
    }
    const val = process.env[ref];
    if (val === undefined) reject('secret_missing', `Environment variable ${ref} is not configured in host secrets`, 409);
    env[key] = val;
    if (val) secrets.push(val);
  }
  return { env, secrets };
}

async function hostCredentialPaths(dataRoot) {
  const home = homedir();
  const paths = [
    join(dataRoot, 'config'),
    resolve(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'),
    process.env.GROK_AUTH_PATH || resolve(process.env.GROK_HOME || join(home, '.grok'), 'auth.json'),
    resolve(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'),
    join(home, '.claude.json'),
    ...['.ssh', '.aws', '.azure', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/gcloud'].map(n => join(home, n)),
  ];
  const resolved = await Promise.all(paths.map(p => realpath(p).catch(() => null)));
  return [...paths, ...resolved.filter(Boolean)];
}

async function readLogPage(filePath, offset = 0, limit = 65_536) {
  const fh = await open(filePath, 'r').catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (!fh) return { text: '', next_offset: offset, more: false };
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(limit, Math.max(0, size - offset));
    if (!len) return { text: '', next_offset: offset, more: false };
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return { text: buf.toString('utf8', 0, bytesRead), next_offset: offset + bytesRead, more: offset + bytesRead < size };
  } finally {
    await fh.close();
  }
}

/**
 * Direct in-memory local execution runner.
 * Two modes only: Bot `scripts/*.mjs` (via Summon's built-in Node) or native `shell`.
 */
export class ExecRunner {
  constructor({ store, dataRoot, releaseRoot = programRoot, workspace, onEvent, onWorkEvent, onProgressChange, redact }) {
    Object.assign(this, {
      store,
      dataRoot: resolve(dataRoot),
      releaseRoot: resolve(releaseRoot),
      workspace: resolve(workspace || join(dataRoot, 'workspace')),
      onEvent,
      onWorkEvent,
      onProgressChange,
      redact: typeof redact === 'function' ? redact : (v => v),
    });
    this.running = new Map(); // sessionId -> LiveRun
    this.closing = false;
  }

  clean(value, runSecrets = []) {
    const redacted = this.redact(value);
    if (!runSecrets.length) return redacted;
    const sorted = [...new Set(runSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
    const strip = s => sorted.reduce((acc, secret) => acc.split(secret).join('[redacted]'), s);
    const visit = v => typeof v === 'string' ? strip(v)
      : Array.isArray(v) ? v.map(visit)
      : plain(v) ? Object.fromEntries(Object.entries(v).map(([k, val]) => [strip(k), visit(val)]))
      : v;
    return visit(redacted);
  }

  logDir(opId) {
    const dir = join(this.dataRoot, 'capabilities', 'exec-logs', opId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  operations(sessionId) {
    return this.store.list(operationRecords)
      .filter(op => op.session_id === sessionId)
      .sort((a, b) => (a.input_revision ?? 0) - (b.input_revision ?? 0));
  }

  async resolveCwd(session) {
    const target = session.workspace?.path || this.workspace;
    const dataRootReal = await realpath(this.dataRoot).catch(() => this.dataRoot);
    const releaseRootReal = await realpath(this.releaseRoot).catch(() => this.releaseRoot);
    const protectedDirs = protectedRuntimeDirs(dataRootReal, releaseRootReal);
    const credentialPaths = await hostCredentialPaths(this.dataRoot);
    const checked = createPathAccess({
      workspace: target, project: target, base: target,
      protectedDirectories: protectedDirs,
      protectedPath: p => credentialPaths.some(c => pathWithin(c, p)),
      accessPolicy: session.path_policy || {},
    });
    const cwd = await checked(target, { directory: true, operations: ['read'], alternative: true });
    if (cwd === dataRootReal || protectedDirs.some(dir => pathWithin(dir, cwd))) {
      reject('workspace_forbidden', 'Execution directory cannot be inside protected Summon directories', 403);
    }
    return cwd;
  }

  async prepareLaunch(session, call, input, prior) {
    const cwd = await this.resolveCwd(session);
    const data = typeof input === 'string' ? { shell: input } : input;
    if (!plain(data)) reject('invalid_exec_input', 'Exec input must be a shell string or { engine | script | shell } object');
    const hasEngine = data.engine !== undefined;
    const hasScript = data.script !== undefined;
    const hasShell = data.shell !== undefined;
    if (Number(hasEngine) + Number(hasScript) + Number(hasShell) !== 1) {
      reject('invalid_exec_input', 'Provide exactly one of engine, script, or shell');
    }

    if (hasEngine) {
      const engineId = String(data.engine || '').trim();
      const engineDir = engineRootDir(this.dataRoot, engineId);
      let meta = {};
      try { meta = JSON.parse(readFileSync(join(engineDir, 'engine.json'), 'utf8')); } catch {}
      const relScript = validateEngineRelPath(typeof meta.script === 'string' && meta.script.trim() ? meta.script : 'bridge.mjs');
      const scriptPath = resolve(engineDir, relScript);
      if (!scriptPath.startsWith(engineDir + sep) || !existsSync(scriptPath)) {
        reject('engine_script_not_found', `Engine script not found: ${engineId}/${relScript}`, 404);
      }
      const optionalSlots = Array.isArray(meta.env_slots) ? meta.env_slots : [];
      const { env, secrets } = buildSafeEnv(data.env, optionalSlots, this.dataRoot);
      const rejectInlineSecrets = values => {
        if (secrets.length && values.some(v => typeof v === 'string' && secrets.some(s => v.includes(s)))) {
          reject('inline_credential_forbidden', 'Pass secret env var names via env instead of inline values');
        }
      };
      const scriptArgs = Array.isArray(data.args) ? data.args.map(String) : [];
      const resumeSessionId = prior?.native_session_id ?? data.payload?.sessionId ?? null;
      const initialInput = JSON.stringify({
        summonStart: {
          ...(plain(data.payload) ? data.payload : typeof data.payload === 'string' ? { text: data.payload } : {}),
          ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
          callId: call.id, cwd, engineDir,
        },
      }) + '\n';
      rejectInlineSecrets([...scriptArgs, initialInput]);
      return {
        file: process.execPath,
        args: [scriptPath, ...scriptArgs],
        cwd, env, secrets,
        protocol: 'summon-jsonl',
        keepInput: true,
        initialInput,
        programLabel: `engine/${engineId}`,
        resumable: true,
        originExecInput: { engine: engineId, args: scriptArgs, env: data.env },
      };
    }

    const { env, secrets } = buildSafeEnv(data.env, null, this.dataRoot);
    const rejectInlineSecrets = values => {
      if (secrets.length && values.some(v => typeof v === 'string' && secrets.some(s => v.includes(s)))) {
        reject('inline_credential_forbidden', 'Pass secret env var names via env instead of inline values');
      }
    };

    if (hasScript) {
      const ownerBotId = data.bot || (session.execution_actor?.kind === 'bot' ? session.execution_actor.id : null);
      if (!ownerBotId) reject('invalid_exec_input', 'Specify bot id when running a Bot script as host user');
      const rel = validateBotRelPath(data.script);
      if (!rel.startsWith('scripts/')) reject('invalid_script', 'Bot scripts must live under scripts/', 403);
      const botDir = botRootDir(this.dataRoot, ownerBotId);
      const scriptPath = resolve(botDir, rel);
      if (!scriptPath.startsWith(join(botDir, 'scripts') + sep) || !existsSync(scriptPath)) {
        reject('script_not_found', `Bot script not found: ${rel}`, 404);
      }
      const scriptArgs = Array.isArray(data.args) ? data.args.map(String) : [];
      const useJsonl = data.protocol === 'summon-jsonl' || data.payload !== undefined;
      const resumeSessionId = prior?.native_session_id ?? data.payload?.sessionId ?? null;
      const initialInput = useJsonl
        ? JSON.stringify({
            summonStart: {
              ...(plain(data.payload) ? data.payload : typeof data.payload === 'string' ? { text: data.payload } : {}),
              ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
              callId: call.id, cwd, botDir,
            },
          }) + '\n'
        : data.stdin;
      rejectInlineSecrets([...scriptArgs, initialInput]);
      return {
        file: process.execPath,
        args: [scriptPath, ...scriptArgs],
        cwd, env, secrets,
        protocol: useJsonl ? 'summon-jsonl' : 'stdin',
        keepInput: data.keep_input ?? useJsonl,
        initialInput,
        programLabel: `${ownerBotId}/${rel}`,
        resumable: data.resume ?? useJsonl,
        originExecInput: { script: rel, bot: ownerBotId, args: scriptArgs, protocol: useJsonl ? 'summon-jsonl' : 'stdin', env: data.env },
      };
    }

    const shellText = data.shell;
    if (!validText(shellText, 65_536)) reject('invalid_exec_input', 'shell must be a non-empty command string');
    rejectInlineSecrets([shellText, data.stdin]);
    return {
      file: windows
        ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : '/bin/sh',
      args: windows
        ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(shellText, 'utf16le').toString('base64')]
        : ['-c', shellText],
      cwd, env, secrets,
      protocol: 'stdin',
      keepInput: data.keep_input === true,
      initialInput: data.stdin,
      programLabel: shellText.replace(/\s+/g, ' ').trim().slice(0, 60),
      resumable: false,
    };
  }

  async open({ session, call, input, beforeSubmit, signal }) {
    signal?.throwIfAborted();
    if (this.closing) reject('exec_closing', 'Gateway is shutting down', 503);
    if (this.running.has(session.id)) reject('execution_busy', 'This Session already has a running process', 409);
    const existing = this.store.get(operationRecords, call.id);
    if (existing) return this.factsFor(existing);
    return this.startRun(session, call, input, beforeSubmit, null);
  }

  async startRun(session, call, input, beforeSubmit, prior) {
    const launch = await this.prepareLaunch(session, call, input, prior);
    if (prior && launch.cwd !== prior.cwd) {
      reject('workspace_binding_changed', 'The original execution working directory changed', 409);
    }
    const opId = call.id;
    const dir = this.logDir(opId);
    const op = this.store.save(operationRecords, {
      id: opId,
      session_id: session.id,
      protocol: launch.protocol,
      cwd: launch.cwd,
      program_label: launch.programLabel,
      resumable: launch.resumable === true,
      origin_exec_input: launch.originExecInput ?? prior?.origin_exec_input ?? null,
      native_session_id: prior?.native_session_id ?? null,
      status: 'running',
      pending: [],
      input_revision: (prior?.input_revision ?? session.input_revision ?? 0) + 1,
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      exit_signal: null,
      error: null,
      result: null,
    });

    await beforeSubmit();

    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      detached: !windows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const live = {
      opId, sessionId: session.id, child, childJob: null,
      secrets: launch.secrets, protocol: launch.protocol, dir,
      stopping: false, settled: false, nativeOutcome: null, finalResult: null,
      stdoutTail: '', stderrTail: '', pending: [], drainTimer: null,
      hasReadableProgress: false,
    };
    this.running.set(session.id, live);

    const writeLog = (file, text) => { try { appendFileSync(join(dir, file), text); } catch {} };
    const emitProgress = text => {
      const cleaned = this.clean(String(text || ''), live.secrets).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!cleaned) return;
      this.store.save(executionRecords, { id: session.id, live_progress: cleaned, updated_at: new Date().toISOString() });
      this.onProgressChange?.(session.id);
    };
    const summarizeToolProgress = ev => {
      if (ev.phase === 'completed') return null;
      const toolName = String(ev.tool || '').trim();
      if (toolName === 'fileChange') {
        const files = String(ev.command || '').split(',').map(part => part.trim()).filter(Boolean)
          .map(part => part.split(/[\\/]/).filter(Boolean).at(-1) || part);
        if (files.length === 1) return `正在修改 ${files[0]}`;
        if (files.length > 1) return `正在修改 ${files[0]} 等 ${files.length} 个文件`;
        return '正在修改文件';
      }
      if (toolName && !['commandExecution', 'shell', 'bash', 'powershell', 'exec'].includes(toolName)) {
        return toolName === 'mcpToolCall' ? '正在调用工具' : `正在调用 ${toolName}`;
      }
      if (live.hasReadableProgress || session.work_summary) return null;
      return '正在执行命令';
    };
    const handleEvent = rawLine => {
      if (live.protocol !== 'summon-jsonl' || !rawLine.trimStart().startsWith('{')) return;
      let ev;
      try { ev = JSON.parse(rawLine)?.summonEvent; } catch { return; }
      if (!plain(ev) || typeof ev.type !== 'string') return;
      writeLog('events.jsonl', JSON.stringify(this.clean({ at: new Date().toISOString(), ...ev }, live.secrets)) + '\n');

      if (ev.type === 'session' && typeof ev.sessionId === 'string' && ev.sessionId) {
        const cleanSid = this.clean(ev.sessionId, live.secrets).slice(0, 512);
        this.store.save(operationRecords, { id: opId, native_session_id: cleanSid });
        this.syncSessionNative(session.id, { session_id: cleanSid });
      } else if (ev.type === 'progress' && typeof ev.text === 'string' && ev.text.trim()) {
        live.hasReadableProgress = true;
        emitProgress(ev.text);
      } else if (ev.type === 'tool') {
        const summary = summarizeToolProgress(ev);
        if (summary) emitProgress(summary);
        this.onWorkEvent?.(session.id, opId, ['item', ev.itemId || randomUUID(), ev.phase || 'call', ev.status || 'running'], {
          program: launch.programLabel, cwd: launch.cwd, phase: ev.phase, status: ev.status, tool: ev.tool, command: ev.command,
          text: typeof ev.text === 'string' ? ev.text.slice(0, 8000) : undefined,
        });
      } else if (ev.type === 'request' && !live.stopping && typeof ev.id === 'string' && ev.id) {
        const choices = Array.isArray(ev.choices) ? ev.choices.filter(c => c?.id && c?.label).map(c => ({ id: String(c.id), label: this.clean(String(c.label), live.secrets) })) : [];
        const req = {
          id: ev.id,
          kind: ['question', 'approval', 'login'].includes(ev.kind) ? ev.kind : 'question',
          text: this.clean(String(ev.text || ''), live.secrets).slice(0, 16_000),
          choices,
          plain_text: !choices.length && ev.plain_text !== false,
        };
        if (!live.pending.some(p => p.id === req.id)) {
          live.pending.push(req);
          const updated = this.store.save(operationRecords, { id: opId, status: 'needs_input', pending: live.pending });
          void this.publishReceipt(updated, `request:${req.id}`);
        }
      } else if ((ev.type === 'resolved' || ev.type === 'withdrawn') && ev.id) {
        live.pending = live.pending.filter(p => p.id !== ev.id);
        this.store.save(operationRecords, { id: opId, status: live.stopping ? 'stopping' : live.pending.length ? 'needs_input' : 'running', pending: live.pending });
      } else if (ev.type === 'result' && typeof ev.text === 'string' && ev.text.trim()) {
        live.finalResult = { text: this.clean(ev.text, live.secrets).slice(0, 32_000), confirmed: ev.confirmed === true };
      } else if (ev.type === 'outcome' && settled(ev.status)) {
        live.nativeOutcome = { status: ev.status, error: ev.error ? this.clean(String(ev.error), live.secrets).slice(0, 4000) : null };
        live.drainTimer = setTimeout(() => {
          if (!live.settled) { live.childJob?.kill(); void terminateTree(child).catch(() => {}); }
        }, 1500);
        live.drainTimer.unref?.();
      }
    };

    let stdoutBuf = '';
    const onStdout = chunk => {
      const cleaned = this.clean(chunk, live.secrets);
      writeLog('stdout.log', cleaned);
      live.stdoutTail = (live.stdoutTail + cleaned).slice(-32_000);
      if (live.protocol === 'summon-jsonl') {
        stdoutBuf += chunk;
        for (let nl = stdoutBuf.indexOf('\n'); nl >= 0; nl = stdoutBuf.indexOf('\n')) {
          handleEvent(stdoutBuf.slice(0, nl));
          stdoutBuf = stdoutBuf.slice(nl + 1);
        }
      }
    };
    const onStderr = chunk => {
      const cleaned = this.clean(chunk, live.secrets);
      writeLog('stderr.log', cleaned);
      live.stderrTail = (live.stderrTail + cleaned).slice(-16_000);
    };

    if (live.protocol === 'summon-jsonl') {
      child.stdout.setEncoding('utf8'); child.stdout.on('data', onStdout);
      child.stderr.setEncoding('utf8'); child.stderr.on('data', onStderr);
    } else {
      pipeNativeText(child.stdout, onStdout);
      pipeNativeText(child.stderr, onStderr);
    }

    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      live.childJob = attachWindowsJob(child.pid);
      this.store.save(operationRecords, { id: opId, child_pid: child.pid });
      this.syncSessionNative(session.id, { pid: child.pid });
      if (launch.initialInput) child.stdin.write(launch.initialInput);
      if (!launch.keepInput) child.stdin.end();
    });

    const finalize = (exitCode, exitSignal, spawnError) => {
      if (live.settled) return;
      live.settled = true;
      clearTimeout(live.drainTimer);
      if (stdoutBuf.trim()) handleEvent(stdoutBuf);
      if (live.stopping || live.interruptedByRestart) live.childJob?.kill();
      else live.childJob?.release();
      if (this.running.get(session.id) === live) this.running.delete(session.id);

      const restarted = Boolean(live.interruptedByRestart);
      const status = restarted
        ? 'failed'
        : (live.nativeOutcome?.status
          || (spawnError ? 'failed' : live.stopping ? 'stopped' : exitCode === 0 ? 'completed' : 'failed'));
      const canContinueAfterRestart = restarted && Boolean(launch.resumable && launch.originExecInput && this.store.get(operationRecords, opId)?.native_session_id);
      const restartError = canContinueAfterRestart
        ? '后台服务更新或重启中断了本次执行；已保留会话上下文，可直接用 send_input(kind:"next") 接着完成。'
        : '后台服务更新或重启中断了本次执行；如需结果可重新发起。';
      const error = restarted
        ? restartError
        : (live.nativeOutcome?.error
          || (spawnError ? this.clean(spawnError.message, live.secrets) : null)
          || (status === 'failed' ? (live.stderrTail.trim() || `Exited with ${exitSignal || `code ${exitCode}`}`) : null));

      let result = live.finalResult;
      if (!result && live.protocol === 'stdin') {
        const text = live.stdoutTail.trim(), stderr = live.stderrTail.trim();
        if (text || stderr) result = { ...(text ? { text } : {}), ...(stderr ? { stderr } : {}) };
      }

      const saved = this.store.save(operationRecords, {
        id: opId, status, pending: [],
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        exit_signal: exitSignal || null,
        ...(restarted ? { interrupted_by_restart: true } : {}),
        error, result,
        finished_at: new Date().toISOString(),
      });
      void this.publishReceipt(saved, restarted ? 'terminal:interrupted_by_restart' : `terminal:${status}`);
      if (session.group_work) {
        this.onWorkEvent?.(session.id, opId, ['status', status], {
          program: launch.programLabel, cwd: launch.cwd, phase: 'execution', status, text: error?.slice(0, 8000), exit_code: exitCode,
        });
      }
    };

    child.once('error', err => finalize(null, null, err));
    child.once('close', (code, sig) => finalize(code, sig, null));

    return this.factsFor(this.store.get(operationRecords, opId) || op);
  }

  async publishReceipt(op, positionKey) {
    if (!this.onEvent) return;
    await this.onEvent(op.session_id, op.id, { ...this.factsFor(op), position: keyOf('exec', op.id, positionKey) });
  }

  factsFor(op) {
    const live = this.running.get(op.session_id);
    const isLive = Boolean(live && live.opId === op.id && !live.settled);
    return this.clean({
      status: op.status,
      ...(op.interrupted_by_restart ? { code: 'interrupted_by_restart' } : {}),
      input_revision: op.input_revision,
      safe_to_disconnect: !isLive,
      can_steer: isLive && Boolean(live.child?.stdin?.writable),
      can_continue: !isLive && op.resumable && Boolean(op.origin_exec_input && op.native_session_id) && ['completed', 'failed', 'stopped'].includes(op.status),
      native: { protocol: op.protocol, pid: isLive ? (op.child_pid || null) : null, session_id: op.native_session_id || null },
      ...(Number.isInteger(op.exit_code) ? { exit_code: op.exit_code } : {}),
      ...(op.exit_signal ? { exit_signal: op.exit_signal } : {}),
      ...(op.result ? { output: op.result } : {}),
      ...(op.error ? { error: op.error } : {}),
      ...(op.pending?.length ? { pending_input: op.pending } : {}),
    });
  }

  async inspect(session, { cursor, limit, stream, modelPage = false } = {}) {
    const ops = this.operations(session.id);
    const latest = ops.at(-1);
    if (!latest) return {};
    const explicitStream = typeof stream === 'string' && stream.length > 0;
    const resolvedStream = explicitStream ? stream : (latest.protocol === 'summon-jsonl' && modelPage ? 'events' : 'stdout');
    if (modelPage && !cursor && !explicitStream && limit === undefined) {
      const facts = this.factsFor(latest);
      if (facts.output || facts.error || settled(latest.status)) {
        return {
          ...facts,
          output_call_id: latest.id,
          next_cursor: keyOf(latest.id, 0, resolvedStream),
        };
      }
      const file = join(this.dataRoot, 'capabilities', 'exec-logs', latest.id, resolvedStream === 'events' ? 'events.jsonl' : `${resolvedStream}.log`);
      const out = await readLogPage(file, 0, 2048);
      return {
        ...facts,
        output_page: this.clean(out),
        output_call_id: latest.id,
        next_cursor: out.more ? keyOf(latest.id, out.next_offset, resolvedStream) : null,
      };
    }
    let offset = 0, selected = latest, targetStream = resolvedStream;
    if (cursor) {
      let parsed;
      try { parsed = JSON.parse(cursor); } catch { reject('invalid_cursor', 'Invalid output cursor'); }
      selected = ops.find(item => item.id === parsed?.[0]) || latest;
      offset = Number.isSafeInteger(parsed?.[1]) && parsed[1] >= 0 ? parsed[1] : 0;
      targetStream = ['stdout', 'stderr', 'events'].includes(parsed?.[2]) ? parsed[2] : targetStream;
    }
    const defaultLimit = modelPage ? 12_288 : 65_536;
    const effectiveLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : defaultLimit;
    const file = join(this.dataRoot, 'capabilities', 'exec-logs', selected.id, targetStream === 'events' ? 'events.jsonl' : `${targetStream}.log`);
    const out = await readLogPage(file, offset, Math.max(1024, Math.min(effectiveLimit, modelPage ? 32_768 : 262_144)));
    return {
      ...this.factsFor(latest),
      output_page: this.clean(out),
      output_call_id: selected.id,
      next_cursor: out.more ? keyOf(selected.id, out.next_offset, targetStream) : null,
    };
  }

  async input({ session, call, kind, input, request_id, beforeSubmit, signal }) {
    signal?.throwIfAborted();
    if (this.closing) reject('exec_closing', 'Gateway is shutting down', 503);
    const latest = this.operations(session.id).at(-1);
    if (!latest) reject('execution_not_found', 'No process exists for this Session', 404);

    if (kind === 'next') {
      if (this.running.has(session.id)) reject('execution_busy', 'Wait for the current turn to finish or steer it instead', 409);
      if (!latest.resumable || !latest.origin_exec_input || !latest.native_session_id) {
        reject('unsupported', 'This Session cannot be resumed with kind:"next"', 409);
      }
      const nextPayload = plain(input) ? input : { text: String(input || '') };
      return this.startRun(session, call, { ...latest.origin_exec_input, payload: nextPayload }, beforeSubmit, latest);
    }

    const live = this.running.get(session.id);
    if (!live || live.settled || !live.child?.stdin?.writable) {
      reject('input_closed', 'The running process is no longer accepting live input', 409);
    }
    const text = typeof input === 'string' ? input : (plain(input) && typeof input.text === 'string' ? input.text : String(input ?? ''));
    if (!validText(text, 32_768)) reject('invalid_input', 'Input must contain 1–32768 characters without NUL');

    let targetRequest = null;
    if (kind === 'reply') {
      targetRequest = request_id ? live.pending.find(p => p.id === request_id) : (live.pending.length === 1 ? live.pending[0] : null);
      if (!targetRequest) reject('request_not_found', 'No matching pending request to reply to', 409);
    }

    await beforeSubmit();
    const wire = live.protocol === 'summon-jsonl'
      ? JSON.stringify({ summonInput: { type: kind === 'reply' ? 'answer' : 'message', id: call.id, requestId: targetRequest?.id || null, text } }) + '\n'
      : text + (text.endsWith('\n') ? '' : '\n');

    await new Promise((resolveWrite, rejectWrite) => {
      live.child.stdin.write(wire, err => (err ? rejectWrite(err) : resolveWrite()));
    });

    if (targetRequest) {
      live.pending = live.pending.filter(p => p.id !== targetRequest.id);
      this.store.save(operationRecords, { id: live.opId, status: live.pending.length ? 'needs_input' : 'running', pending: live.pending });
    }
    const facts = this.factsFor(this.store.get(operationRecords, live.opId) || latest);
    return { ...facts, status: 'completed', session_status: facts.status, input_status: 'delivered' };
  }

  async stop({ session }) {
    const live = this.running.get(session.id);
    if (!live || live.settled) return { status: 'stopped' };
    live.stopping = true;
    if (live.protocol === 'summon-jsonl' && live.child.stdin.writable) {
      try { live.child.stdin.write(JSON.stringify({ summonInput: { type: 'stop' } }) + '\n'); } catch {}
    }
    const deadline = Date.now() + 1200;
    while (!live.settled && Date.now() < deadline) await new Promise(r => setTimeout(r, 80));
    if (!live.settled) {
      live.childJob?.kill();
      await terminateTree(live.child).catch(() => {});
    }
    return { status: 'stopped' };
  }

  syncSessionNative(sessionId, patch) {
    const current = this.store.get(executionRecords, sessionId);
    if (!current) return;
    this.store.save(executionRecords, {
      id: sessionId,
      native: { ...(current.native || {}), ...patch },
      updated_at: new Date().toISOString(),
    });
  }

  recoverInterrupted() {
    const activeStatuses = new Set(['opening', 'running', 'submitted', 'needs_input', 'awaiting_input']);
    const nowIso = new Date().toISOString();
    const recoveredSessions = new Set();
    for (const session of this.store.list(executionRecords)) {
      if (session.engine === 'pi' || !activeStatuses.has(session.status) || this.running.has(session.id)) continue;
      recoveredSessions.add(session.id);
      const op = this.operations(session.id).at(-1) || (session.latest_call_id ? this.store.get(operationRecords, session.latest_call_id) : null);
      const sessionIdNative = op?.native_session_id || session.native?.session_id || null;
      const canContinue = Boolean(op?.resumable && op?.origin_exec_input && sessionIdNative);
      const reason = op?.interrupted_by_restart
        ? '后台服务更新或重启中断了本次执行'
        : '后台执行进程在服务重启或异常退出时已终止';
      const errorText = canContinue
        ? `${reason}；已保留会话上下文，可直接用 send_input(kind:"next") 接着完成。`
        : `${reason}；如需结果可重新发起。`;
      if (op && !settled(op.status)) {
        this.store.save(operationRecords, {
          id: op.id,
          status: 'failed',
          pending: [],
          error: errorText,
          finished_at: nowIso,
        });
      }
      const callId = op?.id || session.latest_call_id;
      const facts = {
        status: 'failed',
        code: 'interrupted_by_restart',
        safe_to_disconnect: true,
        can_steer: false,
        can_continue: canContinue,
        input_revision: op?.input_revision ?? session.input_revision ?? 1,
        native: {
          protocol: op?.protocol || session.native?.protocol || 'stdin',
          pid: null,
          session_id: sessionIdNative,
        },
        error: errorText,
        position: keyOf('exec', callId || session.id, 'recovered:interrupted_by_restart'),
      };
      let delivered = false;
      if (callId && this.onEvent) {
        try {
          this.onEvent(session.id, callId, facts);
          delivered = true;
        } catch {}
      }
      const latestSession = this.store.get(executionRecords, session.id);
      if (!delivered || (latestSession && activeStatuses.has(latestSession.status))) {
        this.store.save(executionRecords, {
          id: session.id,
          status: 'failed',
          pending_input: [],
          live_progress: null,
          can_steer: false,
          can_continue: canContinue,
          safe_to_disconnect: true,
          native: facts.native,
          last_error: { code: 'interrupted_by_restart', message: errorText },
          updated_at: nowIso,
        });
      }
      if (session.group_work && callId) {
        try {
          this.onWorkEvent?.(session.id, callId, ['status', 'failed'], {
            program: op?.program_label || session.engine || 'exec',
            cwd: op?.cwd || session.workspace?.path || this.workspace,
            phase: 'execution',
            status: 'failed',
            text: errorText,
          });
        } catch {}
      }
    }
    for (const op of this.store.list(operationRecords)) {
      if (settled(op.status) || this.running.has(op.session_id) || recoveredSessions.has(op.session_id)) continue;
      this.store.save(operationRecords, {
        id: op.id,
        status: 'failed',
        pending: [],
        error: op.interrupted_by_restart ? '后台服务更新或重启中断了本次执行' : '后台执行进程在服务重启时已终止',
        finished_at: nowIso,
      });
    }
  }

  drainStatus() {
    const active = [...this.running.values()]
      .filter(live => !live.settled)
      .map(live => ({ kind: 'exec', id: live.opId, session_id: live.sessionId, status: 'running', safe_to_disconnect: false }));
    return { active, ready: active.length === 0 };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.values()].map(async live => {
      live.interruptedByRestart = true;
      try {
        const current = this.store.get(operationRecords, live.opId);
        if (current && !settled(current.status)) {
          this.store.save(operationRecords, { id: live.opId, interrupted_by_restart: true });
        }
      } catch {}
      live.childJob?.kill();
      await terminateTree(live.child).catch(() => {});
    }));
    this.running.clear();
  }
}
