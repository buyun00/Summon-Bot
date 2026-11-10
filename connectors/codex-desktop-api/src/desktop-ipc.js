import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FramedPipe } from './framed-pipe.js';
import { ApiError, readBefore, unavailable } from './errors.js';

export const IPC_VERSIONS = { 'thread-owner-discovery': 1, 'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-stream-following-status-requested': 1, 'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1, 'thread-follower-load-complete-history': 1, 'thread-follower-interrupt-turn': 4 };

export class DesktopIpc extends EventEmitter {
  constructor(config) { super(); this.config = config; this.clientId = 'initializing-client'; }
  async connect({ initializeTimeoutMs = this.config.requestTimeoutMs, phase } = {}) {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.clientId !== 'initializing-client') return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (process.platform !== 'win32' && !this.config.ipcPipe) throw unavailable('Configure the running Codex desktop IPC socket (ipcPipe).');
      this.clientId = 'initializing-client';
      const pipe = new FramedPipe(this.config.ipcPipe || '\\\\.\\pipe\\codex-ipc',
        { timeoutMs: this.config.requestTimeoutMs, connectTimeoutMs: this.config.connectTimeoutMs });
      this.pipe?.close(); this.pipe = pipe;
      pipe.on('message', message => {
        if (this.pipe !== pipe) return;
        if (message.type === 'client-discovery-request') pipe.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        if (message.type === 'broadcast') this.emit('broadcast', message);
      });
      pipe.on('disconnected', () => { if (this.pipe === pipe) this.emit('disconnected'); });
      await pipe.connect();
      phase?.('permission-ipc-initialize');
      const response = await this.request('initialize', { clientType: 'codex-cli' }, undefined, 'local', initializeTimeoutMs);
      this.clientId = response.result.clientId;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  request(method, params, targetClientId, hostId = 'local', timeoutMs = this.config.requestTimeoutMs) {
    let version = IPC_VERSIONS[method] || 0;
    const remote = hostId !== 'local';
    if (remote && method.startsWith('thread-follower-')) version++;
    return this.pipe.request({ type: 'request', requestId: randomUUID(), sourceClientId: this.clientId, method, params, version, targetClientId, ...(remote ? { hostId } : {}), timeoutMs: Math.max(1000, timeoutMs - 500) }, timeoutMs);
  }
  async owner(threadId, hostId = 'local', timeoutMs = 15000) {
    await this.connect();
    return (await this.request('thread-owner-discovery', { hostId, conversationId: threadId }, undefined, 'local', timeoutMs)).handledByClientId;
  }
  broadcast(method, params, targetClientIds) {
    this.pipe.send({ type: 'broadcast', method, sourceClientId: this.clientId, version: IPC_VERSIONS[method] || 0, params, ...(targetClientIds ? { targetClientIds } : {}) });
  }
  async follow(threadId, hostId = 'local') {
    const owner = await this.owner(threadId, hostId);
    this.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId, following: true, targetClientIds: [owner] }, [owner]);
    return owner;
  }
  unfollow(threadId, hostId, owner) {
    if (this.pipe?.connected) this.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId, following: false, targetClientIds: [owner] }, [owner]);
  }
  async permissionSnapshot(threadId, timeoutMs = 12000, { deadline = Infinity, phase } = {}) {
    if (!this.pipe?.connected || this.clientId === 'initializing-client') {
      phase?.('permission-ipc-connect');
      const initializeTimeoutMs = Math.max(1, Math.min(this.config.requestTimeoutMs, deadline - Date.now()));
      await readBefore(deadline, () => this.connect({ initializeTimeoutMs, phase }));
    }
    phase?.('permission-owner');
    const owner = await readBefore(deadline, () => this.owner(threadId, 'local', Math.max(1, Math.min(15000, deadline - Date.now()))));
    if (typeof owner !== 'string' || !owner) throw new ApiError(503, 'permission_owner_unavailable', 'Desktop did not identify the exact permission context owner.');
    phase?.('permission-snapshot');
    const pipe = this.pipe;
    // Keep the selected context loaded while the bridge uses it. A new follow
    // requests a fresh snapshot; cached history is not permission evidence.
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.off('broadcast', onMessage); this.off('disconnected', onDisconnect);
        if (error) { try { if (this.pipe === pipe) this.unfollow(threadId, 'local', owner); } catch {} reject(error); }
        else resolve(value);
      };
      const onDisconnect = () => finish(unavailable('Desktop disconnected before permissions were verified.'));
      const onMessage = message => {
        if (message.method === 'client-status-changed' && message.params?.clientId === owner && message.params.status === 'disconnected') return onDisconnect();
        if (message.sourceClientId !== owner || this.pipe !== pipe) return;
        if (message.method !== 'thread-stream-state-changed' || message.params?.conversationId !== threadId || (message.params.hostId ?? 'local') !== 'local') return;
        if (message.version !== IPC_VERSIONS['thread-stream-state-changed']) return finish(new ApiError(502, 'protocol_mismatch', 'Desktop permission snapshot version is incompatible.'));
        if (message.params.change?.type !== 'snapshot') return;
        const state = message.params.change.conversationState;
        if (state?.id !== threadId || !state.currentPermissions) return finish(new ApiError(502, 'permissions_unavailable', 'Desktop did not supply current permissions.'));
        finish(null, { threadId, owner, cwd: state.cwd, permissions: state.currentPermissions });
      };
      const timer = setTimeout(() => finish(new ApiError(503, 'permissions_unavailable', 'Desktop did not provide a fresh permission snapshot.')),
        Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
      this.on('broadcast', onMessage); this.on('disconnected', onDisconnect);
      try {
        this.unfollow(threadId, 'local', owner);
        this.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId: 'local', following: true, targetClientIds: [owner] }, [owner]);
      } catch (error) { finish(error); }
    });
  }
  close() { this.closed = true; this.pipe?.close(); }
}
