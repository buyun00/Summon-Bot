import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FramedPipe } from './framed-pipe.js';
import { unavailable } from './errors.js';

export const IPC_VERSIONS = { 'thread-owner-discovery': 1, 'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-stream-following-status-requested': 1, 'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1, 'thread-follower-load-complete-history': 1, 'thread-follower-interrupt-turn': 4 };

export class DesktopIpc extends EventEmitter {
  constructor(config) { super(); this.config = config; this.clientId = 'initializing-client'; }
  async connect() {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.clientId !== 'initializing-client') return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
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
  close() { this.closed = true; this.pipe?.close(); }
}
