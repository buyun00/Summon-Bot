import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createPathAccess, pathWithin, sensitivePath } from '../../bot/src/capabilities/file-policy.mjs';
import { protectedRuntimeDirs } from '../bot-management/folders.mjs';
import { reject, user } from '../platform/contract.mjs';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMPUTERNAME', 'USERNAME',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'SUMMON_DATA_ROOT', 'SUMMON_RELEASE_NODE', 'SUMMON_RELEASE_RUNNER',
  'CODEX_HOME', 'GROK_HOME', 'GROK_AUTH_PATH', 'CLAUDE_CONFIG_DIR',
]);

const MODEL_PRESETS = Object.freeze({
  deepseek: { name: 'DeepSeek', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { name: 'OpenAI', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
  anthropic: { name: 'Anthropic', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  openrouter: { name: 'OpenRouter', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4' },
});

function validateEnvName(name) {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name) || name.length > 128) {
    reject('invalid_env_name', '环境变量名须以字母或下划线开头，仅含字母、数字和下划线');
  }
  if (RESERVED_ENV_NAMES.has(name.toUpperCase())) {
    reject('reserved_env_name', `系统保留变量 ${name} 不允许通过隐私输入修改`, 403);
  }
  return name;
}

function validateEnvValue(value) {
  if (typeof value !== 'string' || !value.length || value.length > 16384) {
    reject('invalid_secret_value', '凭据内容不能为空且不能超过 16384 个字符');
  }
  if (/[\0\r\n]/.test(value)) {
    reject('invalid_secret_value', '环境变量值不支持包含换行符或空字符');
  }
  return value;
}

function formatEnvLine(name, value) {
  const needsQuote = /^\s|\s$/.test(value) || value.includes('#');
  if (!needsQuote) return `${name}=${value}`;
  if (!value.includes('"')) return `${name}="${value}"`;
  if (!value.includes("'")) return `${name}='${value}'`;
  return `${name}=${value}`;
}

function parseEnvEntries(content) {
  const lines = String(content || '').split(/\r?\n/);
  const keys = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    keys.set(match[1], value);
  }
  return { lines, keys };
}

async function writeEnvFileAtomically(filePath, updates = new Map(), removals = new Set()) {
  await mkdir(dirname(filePath), { recursive: true });
  let existing = '';
  if (existsSync(filePath)) {
    existing = await readFile(filePath, 'utf8');
  }
  const rawLines = existing ? existing.split(/\r?\n/) : [];
  if (rawLines.length && rawLines.at(-1) === '') rawLines.pop();
  const seen = new Set();
  const nextLines = [];
  for (const line of rawLines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const key = match[1];
    if (removals.has(key)) continue;
    if (updates.has(key)) {
      if (!seen.has(key)) {
        nextLines.push(formatEnvLine(key, updates.get(key)));
        seen.add(key);
      }
      continue;
    }
    nextLines.push(line);
  }
  for (const [key, value] of updates.entries()) {
    if (!seen.has(key)) nextLines.push(formatEnvLine(key, value));
  }
  const output = nextLines.length ? `${nextLines.join('\n')}\n` : '';
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, output, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, filePath);
}

/**
 * Direct host-side secret delivery service.
 * Secret values enter only via user-authenticated HTTP routes and are routed directly
 * to runtime.env / model-credentials.json / authorized workspace .env / session stdin,
 * never entering chat messages, SQLite transcripts, or Bot LLM contexts.
 */
export class SecretService {
  constructor({ dataRoot, models, platform, emit = () => {} }) {
    this.dataRoot = resolve(dataRoot);
    this.runtimeEnvPath = join(this.dataRoot, 'config', 'runtime.env');
    this.models = models;
    this.platform = platform;
    this.emit = emit;
    this.registry = new Set();
    this.writeQueue = Promise.resolve();
  }

  attach({ platform, models } = {}) {
    if (platform) this.platform = platform;
    if (models) this.models = models;
  }

  remember(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 6) this.registry.add(trimmed);
    if (value.length >= 6) this.registry.add(value);
    const auth = trimmed.match(/^(?:Bearer|Basic|Token)\s+(.+)$/i);
    if (auth?.[1] && auth[1].length >= 6) this.registry.add(auth[1]);
  }

  secrets() {
    return this.registry;
  }

  async hydrate() {
    if (!existsSync(this.runtimeEnvPath)) return;
    try {
      const content = await readFile(this.runtimeEnvPath, 'utf8');
      const { keys } = parseEnvEntries(content);
      for (const [name, value] of keys.entries()) {
        if (process.env[name] === undefined) process.env[name] = value;
        this.remember(value);
      }
    } catch {}
  }

  serialize(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async listEnvKeys() {
    if (!existsSync(this.runtimeEnvPath)) return { keys: [], path: 'runtime.env' };
    const content = await readFile(this.runtimeEnvPath, 'utf8');
    const { keys } = parseEnvEntries(content);
    return {
      keys: [...keys.keys()].sort().map(name => ({
        name,
        active: process.env[name] !== undefined,
        source: 'runtime.env',
      })),
      path: 'runtime.env',
    };
  }

  async setEnvSecrets(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 20) {
      reject('invalid_secret_entries', '请提供 1 至 20 项有效的环境变量凭据');
    }
    const updates = new Map();
    for (const item of entries) {
      if (!item || typeof item !== 'object') reject('invalid_secret_entries', '凭据条目格式无效');
      const name = validateEnvName(String(item.name || '').trim());
      const value = validateEnvValue(String(item.value ?? ''));
      updates.set(name, value);
    }
    await this.serialize(async () => {
      await writeEnvFileAtomically(this.runtimeEnvPath, updates, new Set());
      for (const [name, value] of updates.entries()) {
        process.env[name] = value;
        this.remember(value);
      }
    });
    const configuredKeys = [...updates.keys()];
    return {
      ok: true,
      target_kind: 'env',
      target_label: '本机凭据库 (runtime.env)',
      configured_keys: configuredKeys,
      detail: `已安全写入 ${configuredKeys.join('、')} 并立即生效`,
    };
  }

  async deleteEnvSecret(rawName) {
    const name = validateEnvName(String(rawName || '').trim());
    await this.serialize(async () => {
      if (existsSync(this.runtimeEnvPath)) {
        await writeEnvFileAtomically(this.runtimeEnvPath, new Map(), new Set([name]));
      }
      delete process.env[name];
    });
    return { ok: true, deleted: name };
  }

  async deliverFileEnv(target, entries) {
    const workspaceArg = typeof target?.workspace === 'string' && target.workspace.trim()
      ? target.workspace.trim()
      : null;
    if (!workspaceArg) reject('invalid_workspace', '请指定目标工作区');
    const relPath = typeof target?.path === 'string' && target.path.trim() ? target.path.trim() : '.env';
    if (isAbsolute(relPath) || relPath.includes('\0') || relPath.split(/[\\/]+/).some(part => !part || part === '.' || part === '..')) {
      reject('invalid_path', '目标环境文件路径必须是工作区内的安全相对路径');
    }
    const workspaceRoot = this.resolveWorkspaceRoot(workspaceArg);
    if (pathWithin(this.dataRoot, workspaceRoot) && relative(join(this.dataRoot, 'workspace'), workspaceRoot).startsWith('..')) {
      reject('protected_path', '不允许直接写入系统内部目录', 403);
    }
    const checkedPath = createPathAccess({
      workspace: workspaceRoot,
      protectedDirectories: protectedRuntimeDirs(this.dataRoot, this.platform.releaseRoot),
      protectedPath: sensitivePath,
    });
    const fullPath = await checkedPath(relPath, { operations: ['write'], file: false, exists: false });
    if (!Array.isArray(entries) || !entries.length || entries.length > 20) {
      reject('invalid_secret_entries', '请提供 1 至 20 项有效的环境变量凭据');
    }
    const updates = new Map();
    for (const item of entries) {
      const name = validateEnvName(String(item?.name || '').trim());
      const value = validateEnvValue(String(item?.value ?? ''));
      updates.set(name, value);
    }
    await this.serialize(async () => {
      await writeEnvFileAtomically(fullPath, updates, new Set());
      for (const value of updates.values()) this.remember(value);
    });
    const configuredKeys = [...updates.keys()];
    return {
      ok: true,
      target_kind: 'file_env',
      target_label: target.label || `${relPath}`,
      path: relPath,
      configured_keys: configuredKeys,
      detail: `已安全写入 ${relPath}（${configuredKeys.join('、')}）`,
    };
  }

  resolveWorkspaceRoot(workspaceArg) {
    const record = this.platform.workspaceRecords().find(item => item.id === workspaceArg);
    if (record) {
      if (record.write === false) reject('workspace_readonly', '目标工作区为只读，无法写入环境文件', 403);
      return this.platform.authorizedDirectory(record.path);
    }
    return this.platform.authorizedDirectory(workspaceArg);
  }

  async deliverModelApiKey(target, fields) {
    const apiKey = String(fields.api_key ?? fields.apiKey ?? fields.key ?? '').trim();
    if (!apiKey) reject('invalid_secret_value', '请输入有效的 API Key');
    this.remember(apiKey);
    const catalog = this.models.catalog();
    const existingId = target.connection_id || fields.connection_id || null;
    const existing = existingId ? catalog.connections.find(item => item.id === existingId) : null;
    const presetKey = String(target.provider || fields.provider || '').trim().toLowerCase();
    const preset = MODEL_PRESETS[presetKey] || null;
    const savePayload = {
      kind: 'api',
      ...(existing ? { id: existing.id } : existingId ? { id: existingId } : {}),
      name: String(fields.name || target.name || existing?.name || preset?.name || '自定义 API').trim(),
      provider: String(fields.provider || target.provider || existing?.provider || preset?.provider || 'openai-compatible').trim(),
      api: String(fields.api || existing?.api || preset?.api || 'openai-completions').trim(),
      baseUrl: String(fields.base_url || fields.baseUrl || target.base_url || existing?.baseUrl || preset?.baseUrl || '').trim(),
      model: String(fields.model || target.model || existing?.model || preset?.model || '').trim(),
      apiKey,
      allowNoKey: false,
      activate: target.activate === true || fields.activate === true || !catalog.activeId,
    };
    const result = await this.models.save(savePayload);
    if (savePayload.activate) this.platform.initializeDefaults();
    this.platform.runtime?.resumeRecoveredRuns?.({ kind: 'model', id: result?.savedId || savePayload.id || null });
    this.emit('models.changed', { id: result?.savedId || savePayload.id || null });
    return {
      ok: true,
      target_kind: 'model_api_key',
      target_label: target.label || `模型连接 · ${savePayload.name}`,
      connection_id: result?.savedId || savePayload.id || null,
      configured_keys: ['API Key'],
      detail: `已安全保存「${savePayload.name}」的模型凭据`,
    };
  }

  async deliverSessionInput(target, fields, clientId) {
    const sessionId = String(target?.session_id || '').trim();
    if (!sessionId) reject('invalid_session', '缺少目标执行会话 ID');
    const rawValues = Object.values(fields || {}).filter(v => typeof v === 'string' && v.length > 0);
    const secretText = typeof fields?.input === 'string' ? fields.input : rawValues.join('\n');
    if (!secretText) reject('invalid_secret_value', '请输入要发送给执行会话的凭据');
    this.remember(secretText);
    const args = {
      target: { kind: 'session', id: sessionId },
      kind: 'reply',
      input: secretText,
      ...(target.request_id ? { request_id: target.request_id } : {}),
      ...(Number.isSafeInteger(target.control_version) ? { control_version: target.control_version } : {}),
    };
    await this.platform.executeTool('send_input', args, { actor: user, clientId });
    return {
      ok: true,
      target_kind: 'session_input',
      target_label: target.label || `执行会话 ${sessionId}`,
      configured_keys: ['会话凭据'],
      detail: '已直接送达目标执行会话，未进入聊天记录',
    };
  }

  async deliver(payload, clientId) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      reject('invalid_arguments', '隐私输入提交格式无效');
    }
    const target = payload.target && typeof payload.target === 'object' ? payload.target : { kind: 'env' };
    const kind = target.kind || 'env';
    const fields = payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields) ? payload.fields : {};
    if (kind === 'env') {
      const entries = Array.isArray(payload.entries)
        ? payload.entries
        : Object.entries(fields).map(([name, value]) => ({ name, value }));
      return this.setEnvSecrets(entries);
    }
    if (kind === 'file_env') {
      const entries = Array.isArray(payload.entries)
        ? payload.entries
        : Object.entries(fields).map(([name, value]) => ({ name, value }));
      return this.deliverFileEnv(target, entries);
    }
    if (kind === 'model_api_key') {
      return this.deliverModelApiKey(target, fields);
    }
    if (kind === 'session_input') {
      return this.deliverSessionInput(target, fields, clientId);
    }
    reject('unsupported_secret_target', `不支持的隐私投递目标：${kind}`);
  }
}
