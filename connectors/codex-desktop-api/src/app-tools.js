import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FramedPipe } from './framed-pipe.js';
import { ApiError, unavailable } from './errors.js';
import { DesktopIpc } from './desktop-ipc.js';
import { assertExecutorConnected } from './executor-connection.js';
import { resolveDirectoryTarget, matchesDirectoryTarget } from './directory-target.js';

export const ALLOWED_TOOLS = new Set(['get_usage_limits', 'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads', 'list_projects', 'create_thread', 'send_message_to_thread', 'set_thread_title', 'set_thread_archived', 'set_thread_read_state']);

// Protocol values verified against desktop 26.1027.3384.0. Do not treat an
// absent/unrecognised UI selection as approval to choose a permission mode.
const PERMISSION_MODES = {
  'full-access': { profileId: ':danger-full-access', sandboxType: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: 'user' },
  'read-only': { profileId: ':read-only', sandboxType: 'readOnly', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  auto: { profileId: ':workspace', sandboxType: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  granular: { profileId: ':workspace', sandboxType: 'workspaceWrite', approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true } }, approvalsReviewer: 'user' },
};

export function readDesktopPermissionDefault(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json')) {
  let atoms;
  try { atoms = JSON.parse(readFileSync(file, 'utf8'))['electron-persisted-atom-state']; }
  catch { throw new ApiError(503, 'desktop_defaults_unavailable', 'Cannot read desktop permission defaults. No chat or message was created.'); }
  const selection = atoms?.['permission-selection-by-host-id:local'];
  const mode = selection == null ? atoms?.['agent-mode-by-host-id']?.local : selection.kind === 'agent-mode' ? selection.agentMode : null;
  const permissions = Object.hasOwn(PERMISSION_MODES, mode ?? '') ? PERMISSION_MODES[mode] : null;
  if (!permissions) throw new ApiError(501, 'unsupported_permission_default', 'The desktop default permission selection is not supported by this adapter. No chat or message was created.');
  return { mode, ...structuredClone(permissions) };
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
  constructor(config, { ipc, readPermissionDefault = readDesktopPermissionDefault } = {}) {
    this.config = config; this.catalog = [];
    this.permissionIpc = ipc || new DesktopIpc(config);
    this.readPermissionDefault = readPermissionDefault;
    this.createQueue = Promise.resolve();
  }
  async connect() {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.catalog.length) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const pipe = new FramedPipe(discoverToolsPipe(this.config.toolsPipe), { maxBytes: 8 * 1024 * 1024, timeoutMs: this.config.requestTimeoutMs });
      this.pipe?.close(); this.pipe = pipe;
      await pipe.connect();
      const response = await pipe.request({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: { threadStartKind: 'all' } });
      if (!Array.isArray(response.result?.tools)) throw new ApiError(502, 'protocol_mismatch', 'Desktop tool catalog is incompatible.');
      this.catalog = response.result.tools;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async call(tool, args = {}) {
    assertExecutorConnected(this.config);
    if (tool === 'create_thread') {
      const operation = this.createQueue.then(() => this.createWithDesktopDefaults(args));
      this.createQueue = operation.catch(() => {});
      return operation;
    }
    return this.callDesktopTool(tool, args);
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
  async permissionContext(expected) {
    const checked = new Set();
    const tryContext = async threadId => {
      if (!threadId || checked.has(threadId)) return null;
      checked.add(threadId);
      let context;
      try { context = await this.permissionIpc.permissionSnapshot(threadId); }
      catch (error) { if (error.code === 'protocol_mismatch') throw error; return null; }
      if (!matchesPermissionDefault(context.permissions, expected)) {
        this.permissionIpc.unfollow(threadId, 'local', context.owner);
        return null;
      }
      if (this.heldPermissionContext?.threadId !== threadId) this.releasePermissionContext();
      this.heldPermissionContext = context;
      return context;
    };
    for (const id of [this.heldPermissionContext?.threadId, this.config.callerThreadId]) {
      const context = await tryContext(id); if (context) return context;
    }
    const catalog = await this.callDesktopTool('list_threads', { limit: this.config.discoveryLimit || 50 });
    const threads = [...(catalog.threads || []), ...(catalog.pinnedThreads || [])]
      .filter(thread => (thread.hostId ?? 'local') === 'local' && (thread.kind ?? 'codex') === 'codex')
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
    for (const thread of threads.slice(0, 12)) {
      const context = await tryContext(thread.id); if (context) return context;
    }
    throw new ApiError(503, 'permission_context_unavailable', 'No loaded desktop context matches the desktop default permissions. Open a local Codex chat using those defaults and try again. No chat or message was created.');
  }
  async createWithDesktopDefaults(args) {
    await this.connect();
    const expected = this.readPermissionDefault();
    const context = await this.permissionContext(expected);
    const directory = args.target?.type === 'directory' ? await resolveDirectoryTarget(args.target.cwd, () => this.callDesktopTool('list_projects')) : null;
    if (directory) args = { ...args, target: { type: 'project', projectId: directory.projectId, environment: { type: 'local' } } };
    if (args.target?.type === 'project') {
      const projects = await this.callDesktopTool('list_projects');
      const project = projects.projects?.find(project => project.projectId === args.target.projectId);
      if (!project) throw new ApiError(400, 'unknown_project', 'Use a projectId returned by list_projects. No message was sent.');
      if (project.hostId !== 'local' || project.projectKind !== 'local') throw new ApiError(501, 'unsupported_permission_host', 'Default permission inheritance is verified for local Codex projects only. No message was sent.');
    }
    // These checks precede the one native creation request. Never send the
    // user's prompt and then try to repair permissions on an active turn.
    if (!isDeepStrictEqual(expected, this.readPermissionDefault())) throw new ApiError(409, 'desktop_defaults_changed', 'Desktop permission defaults changed during creation preflight. No message was sent.');
    const fresh = await this.permissionIpc.permissionSnapshot(context.threadId);
    if (!matchesPermissionDefault(fresh.permissions, expected)) {
      this.permissionIpc.unfollow(fresh.threadId, 'local', fresh.owner); this.releasePermissionContext();
      throw new ApiError(409, 'permission_context_changed', 'Desktop context permissions changed before creation. No message was sent.');
    }
    this.heldPermissionContext = fresh;
    const result = await this.callDesktopTool('create_thread', args, context.threadId);
    if (!result.threadId || (result.hostId ?? 'local') !== 'local') throw new ApiError(502, 'creation_unconfirmed', 'Desktop did not confirm a local chat id. Inspect the operation before any further write.', { outcome: 'unknown', desktopResult: result });
    let observed;
    try { observed = await this.permissionIpc.permissionSnapshot(result.threadId); }
    catch { throw new ApiError(502, 'created_permissions_unconfirmed', 'Chat creation was accepted but permission verification is unavailable. Do not resubmit.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true }); }
    finally { if (observed) this.permissionIpc.unfollow(result.threadId, 'local', observed.owner); }
    if (!matchesPermissionDefault(observed.permissions, expected)) throw new ApiError(502, 'created_permissions_mismatch', 'Desktop did not inherit the verified context permissions. Do not resubmit or assume full access.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true });
    if (directory && !await matchesDirectoryTarget(observed.cwd, directory.cwd)) throw new ApiError(502, 'created_directory_mismatch', 'The created chat did not confirm the authorized directory. Inspect this thread; do not resubmit.', { outcome: 'unknown', threadId: result.threadId, firstMessageSubmitted: true });
    return { ...result, ...(directory ? { directoryTarget: directory } : {}), permissionInheritance: { source: 'desktop_default', mode: expected.mode, profileId: expected.profileId, approvalPolicy: expected.approvalPolicy, approvalsReviewer: expected.approvalsReviewer, contextVerifiedBeforeFirstMessage: true, verifiedAfterCreation: true } };
  }
  releasePermissionContext() {
    const context = this.heldPermissionContext;
    if (context) this.permissionIpc.unfollow(context.threadId, 'local', context.owner);
    this.heldPermissionContext = null;
  }
  async callDesktopTool(tool, args = {}, callerThreadId = this.config.callerThreadId) {
    assertExecutorConnected(this.config);
    if (!ALLOWED_TOOLS.has(tool)) throw new ApiError(403, 'tool_not_allowed', 'This tool is not exposed by the API.');
    await this.connect();
    assertExecutorConnected(this.config);
    if (!this.catalog.some(entry => entry.namespace === 'codex_app' && entry.name === tool)) throw new ApiError(501, 'unsupported_capability', `Desktop does not advertise ${tool}.`);
    if (!callerThreadId) throw new ApiError(503, 'caller_thread_required', 'Set callerThreadId to an existing local Codex chat for desktop tool context.');
    const id = randomUUID();
    const response = await this.pipe.request({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', hostId: 'local',
      threadId: callerThreadId, turnId: `desktop-api-${id}`, callId: `desktop-api-${id}`,
    } }, this.config.requestTimeoutMs);
    const result = response.result;
    if (!result || result.success !== true) {
      const detail = result?.contentItems?.filter(item => typeof item.text === 'string').map(item => item.text).join('\n') || 'Desktop tool reported failure.';
      throw new ApiError(/invalid arguments/.test(detail) ? 400 : 502, 'desktop_tool_failed', detail.slice(0, 4000));
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
