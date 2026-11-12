import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FramedPipe } from './framed-pipe.js';
import { ApiError, modelPreflightUnavailable, permissionPreflightUnavailable, readBefore, unavailable } from './errors.js';
import { DesktopIpc } from './desktop-ipc.js';
import { assertExecutorConnected } from './executor-connection.js';
import { directoryPath, resolveDirectoryTarget, matchesDirectoryTarget } from './directory-target.js';

export const ALLOWED_TOOLS = new Set(['get_usage_limits', 'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads', 'list_projects', 'create_thread', 'send_message_to_thread', 'set_thread_title', 'set_thread_archived', 'set_thread_read_state']);

// Protocol values verified against desktop 26.1027.3384.0. Do not treat an
// absent/unrecognised UI selection as approval to choose a permission mode.
const PERMISSION_MODES = {
  'full-access': { profileId: ':danger-full-access', sandboxType: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: 'user' },
  'read-only': { profileId: ':read-only', sandboxType: 'readOnly', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  auto: { profileId: ':workspace', sandboxType: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  granular: { profileId: ':workspace', sandboxType: 'workspaceWrite', approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true } }, approvalsReviewer: 'user' },
};
const transientPermissionReads = new Set(['desktop_unavailable', 'desktop_timeout', 'connection_lost', 'desktop_error',
  'permission_owner_unavailable', 'permissions_unavailable', 'preflight_read_timeout']);

export function readDesktopPermissionDefault(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json')) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new ApiError(503, 'desktop_defaults_unavailable', 'Cannot read desktop permission defaults. No chat or message was created.'); }
  const accountOwner = state?.['electron-renderer-content-owner'];
  const signedIn = typeof accountOwner === 'string' && accountOwner !== '' &&
    accountOwner.trim() === accountOwner && accountOwner !== 'signed-out';
  const atoms = signedIn ? state[`electron-owner-atoms:${accountOwner}`] : null;
  const selection = atoms?.['permission-selection-by-host-id:local'];
  const mode = selection?.kind === 'agent-mode' ? selection.agentMode : null;
  if (typeof mode !== 'string' || !Object.hasOwn(PERMISSION_MODES, mode))
    throw new ApiError(501, 'unsupported_permission_default', 'The desktop default permission selection is not supported by this adapter. No chat or message was created.');
  // Keep the owner in the preflight comparison even if two accounts use the same mode.
  return { accountOwner, mode, ...structuredClone(PERMISSION_MODES[mode]) };
}

export function matchesPermissionDefault(permissions, expected) {
  const sandbox = permissions?.sandboxPolicy;
  return permissions?.activePermissionProfile?.id === expected.profileId && permissions.activePermissionProfile.extends == null &&
    sandbox?.type === expected.sandboxType && permissions.approvalsReviewer === expected.approvalsReviewer &&
    isDeepStrictEqual(permissions.approvalPolicy, expected.approvalPolicy) &&
    (expected.sandboxType === 'dangerFullAccess' || sandbox.networkAccess === false);
}

export function discoverToolsPipe(explicit) {
  if (explicit) return explicit;
  if (process.platform !== 'win32') throw unavailable('Configure the running Codex desktop tool socket (toolsPipe).');
  const names = readdirSync('\\\\.\\pipe\\').filter(name => /^codex-app-tools-[0-9a-f-]+$/i.test(name));
  if (names.length !== 1) throw unavailable(names.length ? 'Multiple desktops found; configure toolsPipe explicitly.' : 'No Codex desktop tool pipe found.');
  return `\\\\.\\pipe\\${names[0]}`;
}

export class AppTools {
  constructor(config, { ipc, readPermissionDefault = readDesktopPermissionDefault, permissionCandidates = () => [] } = {}) {
    this.config = config; this.catalog = [];
    this.permissionIpc = ipc || new DesktopIpc(config);
    this.readPermissionDefault = readPermissionDefault;
    this.permissionCandidates = permissionCandidates;
    this.createQueue = Promise.resolve();
  }
  async connect() {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.catalog.length) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const pipe = new FramedPipe(discoverToolsPipe(this.config.toolsPipe), { maxBytes: 8 * 1024 * 1024,
        timeoutMs: this.config.requestTimeoutMs, connectTimeoutMs: this.config.connectTimeoutMs });
      this.pipe?.close(); this.pipe = pipe;
      await pipe.connect();
      await this.refreshCatalog(pipe);
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async refreshCatalog(pipe) {
    const response = await pipe.request({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: { threadStartKind: 'all' } });
    if (!Array.isArray(response.result?.tools)) throw new ApiError(502, 'protocol_mismatch', 'Desktop tool catalog is incompatible.');
    if (this.pipe === pipe) this.catalog = response.result.tools;
  }
  async call(tool, args = {}, phase, recovery, deadline) {
    assertExecutorConnected(this.config);
    if (tool === 'create_thread') {
      phase?.('queued');
      let release;
      const prior = this.createQueue;
      this.createQueue = new Promise(resolve => { release = resolve; });
      // Serialize the shared permission context until the native call is
      // posted. Each submitted RPC owns its own later response and readback.
      return prior.then(() => this.createWithDesktopDefaults(args, (stage, detail) => {
        phase?.(stage, detail);
        if (stage === 'desktop-write') release();
      }, recovery, deadline)).finally(release);
    }
    phase?.('connect');
    return this.callDesktopTool(tool, args, this.config.callerThreadId, phase);
  }
  async verifyPermissions() {
    if (!this.config.callerThreadId) throw unavailable('请填写一个使用当前默认权限的本机 Codex 会话 ID。');
    const expected = this.readPermissionDefault();
    const context = await this.permissionIpc.permissionSnapshot(this.config.callerThreadId);
    try {
      if (!matchesPermissionDefault(context.permissions, expected)) throw unavailable('当前会话权限与 Codex 桌面的默认权限不一致。请打开使用默认权限的本机会话。');
      return true;
    } finally { this.permissionIpc.unfollow(context.threadId, 'local', context.owner); }
  }
  async readPermissionContext(threadId, expected, deadline, phase, contextSource, step) {
    let readPhase;
    try {
      return await this.permissionIpc.permissionSnapshot(threadId, 12000, { deadline, phase: stage => {
        readPhase = stage;
        phase?.(stage, { contextSource, step });
      } });
    } catch (error) {
      if (!readPhase || !transientPermissionReads.has(error.code)) throw error;
      throw new ApiError(503, permissionPreflightUnavailable, 'Desktop could not read the current permission context before creation.',
        { outcome: 'not-submitted', permissionMode: expected.mode, phase: readPhase, contextSource, step, reason: error.code });
    }
  }
  async permissionContext(expected, deadline, phase) {
    phase?.('permission-candidates');
    const checked = new Set();
    let failure;
    const candidates = [{ threadId: this.heldPermissionContext?.threadId, source: 'held' },
      { threadId: this.config.callerThreadId, source: 'configured' }, ...this.permissionCandidates(expected)];
    for (const { threadId, source } of candidates) {
      if (Date.now() >= deadline) break;
      if (!threadId || checked.has(threadId)) continue;
      checked.add(threadId);
      let context;
      try { context = await this.readPermissionContext(threadId, expected, deadline, phase, source, 'select'); }
      catch (error) {
        if (error.code !== permissionPreflightUnavailable) throw error;
        failure = error;
        continue;
      }
      if (!matchesPermissionDefault(context.permissions, expected)) {
        this.permissionIpc.unfollow(threadId, 'local', context.owner);
        continue;
      }
      if (this.heldPermissionContext?.threadId !== threadId) this.releasePermissionContext();
      this.heldPermissionContext = context;
      return { ...context, source };
    }
    if (failure) throw failure;
    throw new ApiError(503, 'permission_context_unavailable', 'No loaded desktop context matches the desktop default permissions. Open a local Codex chat using those defaults and try again. No chat or message was created.');
  }
  async createWithDesktopDefaults(args, phase, recovery, deadline = Date.now() + this.config.acknowledgementTimeoutMs) {
    phase?.('permission-defaults');
    const expected = this.readPermissionDefault();
    if (recovery && recovery.permissionMode !== expected.mode)
      throw new ApiError(409, 'desktop_defaults_changed', 'Desktop permission defaults changed since the original create preflight. No message was sent.');
    const selectionDeadline = Math.min(deadline, Date.now() + Math.min(this.config.requestTimeoutMs, this.config.acknowledgementTimeoutMs / 2));
    const context = await this.permissionContext(expected, selectionDeadline, phase);
    phase?.('tool-catalog');
    await readBefore(deadline, () => this.connect());
    if (recovery?.code === modelPreflightUnavailable) await readBefore(deadline, () => this.refreshCatalog(this.pipe));
    const listProjects = () => {
      phase?.('project-catalog');
      return this.callDesktopTool('list_projects', {}, context.threadId);
    };
    let directory;
    if (args.target?.type === 'directory') {
      directory = await readBefore(deadline, () =>
        resolveDirectoryTarget(args.target.cwd, listProjects, () => phase?.('directory-registration')));
      args = { ...args, target: { type: 'project', projectId: directory.projectId, environment: { type: 'local' } } };
    } else if (args.target?.type === 'project') {
      const projects = await readBefore(deadline, listProjects);
      const project = projects.projects?.find(project => project.projectId === args.target.projectId);
      if (!project) throw new ApiError(400, 'unknown_project', 'Use a projectId returned by list_projects. No message was sent.');
      if (project.hostId !== 'local' || project.projectKind !== 'local') throw new ApiError(501, 'unsupported_permission_host', 'Default permission inheritance is verified for local Codex projects only. No message was sent.');
      const cwd = await readBefore(deadline, () => directoryPath(project.path));
      directory = { cwd, projectId: project.projectId, hostId: project.hostId };
    }
    // These checks precede the one native creation request. Never send the
    // user's prompt and then try to repair permissions on an active turn.
    phase?.('permission-before-write');
    if (!isDeepStrictEqual(expected, this.readPermissionDefault())) throw new ApiError(409, 'desktop_defaults_changed', 'Desktop permission defaults changed during creation preflight. No message was sent.');
    const fresh = await this.readPermissionContext(context.threadId, expected, deadline, phase, context.source, 'before-write');
    if (fresh.owner !== context.owner || !matchesPermissionDefault(fresh.permissions, expected) || !isDeepStrictEqual(expected, this.readPermissionDefault())) {
      this.permissionIpc.unfollow(fresh.threadId, 'local', fresh.owner); this.releasePermissionContext();
      throw new ApiError(409, 'permission_context_changed', 'Desktop context permissions changed before creation. No message was sent.');
    }
    this.heldPermissionContext = fresh;
    let result;
    try { result = await this.callDesktopTool('create_thread', args, context.threadId, phase); }
    catch (error) {
      if (error.code === modelPreflightUnavailable && error.details?.outcome === 'not-submitted')
        error.details.permissionMode = expected.mode;
      throw error;
    }
    if (!result.threadId || (result.hostId ?? 'local') !== 'local') throw new ApiError(502, 'creation_unconfirmed', 'Desktop did not confirm a local chat id. Inspect the operation before any further write.', { outcome: 'unknown', desktopResult: result });
    let observed;
    phase?.('permission-readback', { threadId: result.threadId });
    try { observed = await this.permissionIpc.permissionSnapshot(result.threadId, 60000); }
    catch { throw new ApiError(502, 'created_permissions_unconfirmed', 'Chat creation was accepted but permission verification is unavailable. Do not resubmit.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true }); }
    finally { if (observed) this.permissionIpc.unfollow(result.threadId, 'local', observed.owner); }
    if (!matchesPermissionDefault(observed.permissions, expected)) throw new ApiError(502, 'created_permissions_mismatch', 'Desktop did not inherit the verified context permissions. Do not resubmit or assume full access.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true });
    if (directory) {
      phase?.('directory-readback', { threadId: result.threadId });
      if (observed.threadId !== result.threadId || (result.projectId != null && result.projectId !== directory.projectId) ||
          !await matchesDirectoryTarget(observed.cwd, directory.cwd))
        throw new ApiError(502, 'created_directory_mismatch', 'The created chat did not confirm the authorized directory. Inspect this thread; do not resubmit.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true });
    }
    return { ...result, ...(directory ? { directoryTarget: directory } : {}), permissionInheritance: { source: 'desktop_default', mode: expected.mode, profileId: expected.profileId, approvalPolicy: expected.approvalPolicy, approvalsReviewer: expected.approvalsReviewer, contextVerifiedBeforeFirstMessage: true, verifiedAfterCreation: true } };
  }
  releasePermissionContext() {
    const context = this.heldPermissionContext;
    if (context) this.permissionIpc.unfollow(context.threadId, 'local', context.owner);
    this.heldPermissionContext = null;
  }
  async callDesktopTool(tool, args = {}, callerThreadId = this.config.callerThreadId, phase) {
    assertExecutorConnected(this.config);
    if (!ALLOWED_TOOLS.has(tool)) throw new ApiError(403, 'tool_not_allowed', 'This tool is not exposed by the API.');
    await this.connect();
    assertExecutorConnected(this.config);
    if (!this.catalog.some(entry => entry.namespace === 'codex_app' && entry.name === tool)) throw new ApiError(501, 'unsupported_capability', `Desktop does not advertise ${tool}.`);
    if (!callerThreadId) throw new ApiError(503, 'caller_thread_required', 'Set callerThreadId to an existing local Codex chat for desktop tool context.');
    const id = randomUUID();
    const mutation = ['create_thread', 'send_message_to_thread'].includes(tool);
    if (mutation) phase?.('desktop-write', { requestId: id });
    let response;
    try {
      response = await this.pipe.request({ jsonrpc: '2.0', id, method: 'tools/call', params: {
        namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', hostId: 'local',
        threadId: callerThreadId, turnId: `desktop-api-${id}`, callId: `desktop-api-${id}`,
      } }, mutation ? this.config.mutationTimeoutMs : this.config.requestTimeoutMs);
    } catch (error) {
      if (mutation && error.code === 'desktop_error')
        throw new ApiError(error.status, error.code, error.message, { outcome: 'unknown' });
      throw error;
    }
    const result = response.result;
    if (!result || result.success !== true) {
      const detail = result?.contentItems?.filter(item => typeof item.text === 'string').map(item => item.text).join('\n') || 'Desktop tool reported failure.';
      if (tool === 'create_thread' && args.model) {
        const catalogFailure = args.thinking ?
          `create_thread could not validate reasoning effort "${args.thinking}" for model "${args.model}". Use a model and reasoning combination listed in the tool description, or omit thinking.` :
          `create_thread could not validate model "${args.model}". Use a model listed in the tool description, or omit model.`;
        // These native guards return before the creation routine is invoked.
        if (detail === catalogFailure) throw new ApiError(503, modelPreflightUnavailable,
          `Desktop could not validate the requested model settings against its current catalog. Creation stopped during preflight. ${args.model}${args.thinking ? ` / ${args.thinking}` : ''}`,
          { outcome: 'not-submitted' });
        const unsupported = `create_thread rejected unsupported model/reasoning combination: "${args.model}" does not support "${args.thinking}". `;
        if (args.thinking && detail.startsWith(unsupported) &&
          /^(This model supports no reasoning effort overrides\.|Supported reasoning efforts: [a-z, ]+\.)$/.test(detail.slice(unsupported.length)))
          throw new ApiError(400, 'desktop_model_reasoning_unsupported', detail);
      }
      const invalid = tool === 'create_thread' ? detail.startsWith('create_thread invalid arguments') : /invalid arguments/.test(detail);
      throw new ApiError(invalid ? 400 : 502, 'desktop_tool_failed', detail.slice(0, 4000),
        mutation && !invalid ? { outcome: 'unknown' } : undefined);
    }
    const content = result.contentItems ?? [];
    const texts = content.filter(item => item.type === 'inputText' || item.type === 'text').map(item => item.text);
    for (const text of texts) { try { return JSON.parse(text); } catch {} }
    return { content };
  }
  close() { this.closed = true; this.releasePermissionContext(); this.permissionIpc.close(); this.pipe?.close(); }
}

// Keep desktop payload interpretation inside the protocol adapter.
export function normalizeUsage(payload, observedAt = new Date().toISOString()) {
  const notes = ['Quota is percent capacity (100), not an absolute token/message allowance.',
    'observedAt is bridge receipt time, not an upstream measurement timestamp.',
    'periodStart is derived from periodEnd minus windowDurationMins.'];
  const byId = payload?.rateLimitsByLimitId;
  const buckets = byId && typeof byId === 'object' && !Array.isArray(byId) && Object.keys(byId).length
    ? Object.entries(byId) : payload?.rateLimits ? [[payload.rateLimits.limitId ?? 'legacy', payload.rateLimits]] : [];
  const windows = [];
  for (const [limitId, bucket] of buckets) {
    for (const window of ['primary', 'secondary']) {
      const value = bucket?.[window];
      if (!value) continue;
      const used = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 ? value.usedPercent : null;
      const endMs = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt * 1000 : NaN;
      const validEnd = Number.isFinite(new Date(endMs).getTime());
      const missing = [];
      if (used === null) missing.push('Invalid or missing usedPercent; used and remaining are null.');
      if (!validEnd) missing.push('Invalid or missing resetsAt; period boundaries are null.');
      windows.push({ limitId, window, limit: 100, used, remaining: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
        unit: 'percent', windowDurationMins: value.windowDurationMins, periodStart: validEnd && Number.isFinite(value.windowDurationMins) ? new Date(endMs - value.windowDurationMins * 60000).toISOString() : null,
        periodEnd: validEnd ? new Date(endMs).toISOString() : null, periodStartDerived: validEnd, notes: missing });
    }
  }
  const weekly = windows.filter(value => value.windowDurationMins === 10080);
  if (!weekly.length) notes.push('No identifiable weekly window (10080 minutes); weekly is null. Missing usage is not zero usage.');
  const primary = buckets[0]?.[1];
  const credit = primary?.credits;
  return { source: 'desktop_get_usage_limits', hostId: 'local', observedAt, windows, weekly: weekly.length ? weekly : null,
    planType: primary?.planType || null, credits: credit ? { hasCredits: credit.hasCredits, unlimited: credit.unlimited, balance: credit.balance } : null, notes };
}
