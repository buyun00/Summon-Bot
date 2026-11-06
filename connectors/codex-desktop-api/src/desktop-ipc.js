import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FramedPipe } from './framed-pipe.js';
import { ApiError, unavailable } from './errors.js';

export const IPC_VERSIONS = { 'thread-owner-discovery': 1, 'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-stream-following-status-requested': 1, 'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1, 'thread-follower-load-complete-history': 1, 'thread-follower-interrupt-turn': 4 };

export class DesktopIpc extends EventEmitter {
  constructor(config) { super(); this.config = config; this.clientId = 'initializing-client'; }
  async connect() {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.clientId !== 'initializing-client') return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (process.platform !== 'win32' && !this.config.ipcPipe) throw unavailable('Configure the running Codex desktop IPC socket (ipcPipe).');
      this.clientId = 'initializing-client';
      const pipe = new FramedPipe(this.config.ipcPipe || '\\\\.\\pipe\\codex-ipc', { timeoutMs: this.config.requestTimeoutMs });
      this.pipe?.close(); this.pipe = pipe;
      pipe.on('message', message => {
        if (message.type === 'client-discovery-request') pipe.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        if (message.type === 'broadcast') this.emit('broadcast', message);
      });
      pipe.on('disconnected', () => this.emit('disconnected'));
      await pipe.connect();
      const response = await this.request('initialize', { clientType: 'codex-cli' });
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
  async owner(threadId, hostId = 'local') {
    await this.connect();
    return (await this.request('thread-owner-discovery', { hostId, conversationId: threadId }, undefined, 'local', 6000)).handledByClientId;
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
  async permissionSnapshot(threadId, timeoutMs = 3000) {
    const owner = await this.owner(threadId);
    // Keep the selected context loaded while the bridge uses it. A new follow
    // requests a fresh snapshot; cached history is not permission evidence.
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.off('broadcast', onMessage); this.off('disconnected', onDisconnect);
        if (error) { this.unfollow(threadId, 'local', owner); reject(error); }
        else resolve(value);
      };
      const onDisconnect = () => finish(unavailable('Desktop disconnected before permissions were verified.'));
      const onMessage = message => {
        if (message.sourceClientId !== owner) return;
        if (message.method === 'client-status-changed' && message.params?.clientId === owner && message.params.status === 'disconnected') return onDisconnect();
        if (message.method !== 'thread-stream-state-changed' || message.params?.conversationId !== threadId || (message.params.hostId ?? 'local') !== 'local') return;
        if (message.version !== IPC_VERSIONS['thread-stream-state-changed']) return finish(new ApiError(502, 'protocol_mismatch', 'Desktop permission snapshot version is incompatible.'));
        if (message.params.change?.type !== 'snapshot') return;
        const state = message.params.change.conversationState;
        if (state?.id !== threadId || !state.currentPermissions) return finish(new ApiError(502, 'permissions_unavailable', 'Desktop did not supply current permissions.'));
        finish(null, { threadId, owner, cwd: state.cwd, permissions: state.currentPermissions });
      };
      const timer = setTimeout(() => finish(new ApiError(503, 'permissions_unavailable', 'Desktop did not provide a fresh permission snapshot. No message was sent.')), timeoutMs);
      this.on('broadcast', onMessage); this.on('disconnected', onDisconnect);
      try {
        this.unfollow(threadId, 'local', owner);
        this.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId: 'local', following: true, targetClientIds: [owner] }, [owner]);
      } catch (error) { finish(error); }
    });
  }
  close() { this.closed = true; this.pipe?.close(); }
}
