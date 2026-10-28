import { EventEmitter } from 'node:events';
import { ApiError } from './errors.js';
import { IPC_VERSIONS } from './desktop-ipc.js';
import { applyPatches, normalizeState } from './state.js';

export class Broker extends EventEmitter {
  constructor(config, tools, ipc, store) {
    super(); this.setMaxListeners(0);
    Object.assign(this, { config, tools, ipc, store });
    this.subscriptions = new Map(); this.lastCatalog = null; this.closed = false;
    this.lastError = null; this.protocolVersion = null;
    ipc.on('broadcast', message => this.receive(message));
    ipc.on('disconnected', () => {
      for (const slot of this.subscriptions.values()) this.invalidate(slot, 'connection_lost');
      if (!this.closed) this.publish('desktop.disconnected', { status: 'unavailable', cachedStatesAreStale: true });
    });
  }
  publish(type, data, threadId, hostId) {
    if (this.closed) return;
    const event = this.store.append(type, data, threadId, hostId);
    this.emit('event', event);
    return event;
  }
  key(threadId, hostId = 'local') { return `${hostId}:${threadId}`; }
  invalidate(slot, reason) {
    slot.stale = true; slot.owner = null;
    this.publish('thread.status', { status: 'unknown', stale: true, reason, lastObservedAt: slot.observedAt ?? null }, slot.threadId, slot.hostId);
  }
  async follow(threadId, hostId = 'local') {
    const key = this.key(threadId, hostId);
    let slot = this.subscriptions.get(key);
    if (!slot) {
      if (this.subscriptions.size >= this.config.maxSubscriptions) throw new ApiError(429, 'subscription_limit', 'Too many live thread subscriptions.');
      slot = { threadId, hostId, stale: true, state: null, owner: null };
      this.subscriptions.set(key, slot);
    }
    slot.usedAt = Date.now();
    if (slot.owner && !slot.stale) return slot;
    if (slot.pending) return slot.pending;
    slot.pending = (async () => {
      await this.ipc.connect();
      slot.owner = await this.ipc.owner(threadId, hostId);
      this.ipc.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId, following: true, targetClientIds: [slot.owner] }, [slot.owner]);
      return slot;
    })().finally(() => { slot.pending = null; });
    return slot.pending;
  }
  async state(threadId, hostId = 'local') {
    const slot = await this.follow(threadId, hostId);
    if (slot.state && !slot.stale) return slot.normalized;
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.off('state', onState); };
      const onState = key => { if (key === this.key(threadId, hostId) && !slot.stale) { done(); resolve(slot.normalized); } };
      const timer = setTimeout(() => { done(); reject(new ApiError(503, 'live_state_unavailable', 'The desktop did not provide a current snapshot. No task was resumed.')); }, 8000);
      this.on('state', onState);
    });
  }
  receive(message) {
    if (this.closed) return;
    if (message.method === 'client-status-changed' && message.params.status === 'disconnected') {
      for (const slot of this.subscriptions.values()) if (slot.owner === message.params.clientId) this.invalidate(slot, 'owner_disconnected');
    }
    if (message.method === 'ipc-connection-reset') {
      for (const slot of this.subscriptions.values()) this.invalidate(slot, 'desktop_reset');
      return;
    }
    if (message.method === 'thread-stream-following-status-requested') {
      const { conversationId, hostId = 'local' } = message.params;
      const slot = this.subscriptions.get(this.key(conversationId, hostId));
      if (slot) this.ipc.broadcast('thread-stream-following-changed', { conversationId, hostId, following: true, targetClientIds: [message.sourceClientId] }, [message.sourceClientId]);
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    const { conversationId, hostId = 'local', change } = message.params || {};
    const key = this.key(conversationId, hostId), slot = this.subscriptions.get(key);
    if (!slot || message.sourceClientId !== slot.owner) return;
    if (message.version !== IPC_VERSIONS['thread-stream-state-changed']) {
      slot.stale = true; this.protocolVersion = null; this.lastError = 'Desktop IPC version changed; adapter update required.';
      this.publish('desktop.protocol_mismatch', { expected: 11, actual: message.version }, conversationId, hostId);
      return;
    }
    try {
      const previous = slot.normalized;
      if (change.type === 'snapshot') slot.state = change.conversationState;
      else if (change.type === 'patches' && slot.state && !slot.stale && slot.revision === change.baseRevision) slot.state = applyPatches(slot.state, change.patches);
      else {
        slot.stale = true;
        this.publish('thread.gap', { reason: 'revision_gap', expected: slot.revision, actual: change.baseRevision }, conversationId, hostId);
        this.resync(slot); return;
      }
      slot.revision = change.revision; slot.observedAt = new Date().toISOString(); slot.stale = false;
      this.protocolVersion = message.version;
      slot.normalized = normalizeState(slot.state, { revision: slot.revision, observedAt: slot.observedAt });
      const current = slot.normalized;
      if (!previous || change.type === 'snapshot') this.publish('thread.snapshot', current, conversationId, hostId);
      else {
        if (JSON.stringify([previous.status, previous.currentTurn, previous.pendingRequests]) !== JSON.stringify([current.status, current.currentTurn, current.pendingRequests])) {
          this.publish('thread.status', { status: current.status, runtimeStatus: current.runtimeStatus, currentTurn: current.currentTurn, pendingRequests: current.pendingRequests, observedAt: current.observedAt, revision: current.revision }, conversationId, hostId);
        }
        const oldItems = new Map(previous.items.map(item => [item.id, item]));
        for (const item of current.items) {
          const old = oldItems.get(item.id);
          if (JSON.stringify(old) === JSON.stringify(item)) continue;
          this.publish('item.updated', { turnId: current.currentTurn?.id, item, revision: current.revision }, conversationId, hostId);
          for (const field of ['text', 'output']) {
            const value = item[field]; const before = old?.[field];
            if (value?.text && !value.truncated && (!before || !before.truncated) && value.text.startsWith(before?.text || '') && value.text !== before?.text) {
              this.publish('output.delta', { turnId: current.currentTurn?.id, itemId: item.id, field, delta: value.text.slice(before?.text.length || 0), revision: current.revision }, conversationId, hostId);
            }
          }
        }
      }
      this.emit('state', key);
    } catch (error) {
      slot.stale = true; this.lastError = error.message;
      this.publish('thread.gap', { reason: 'invalid_patch' }, conversationId, hostId);
      this.resync(slot);
    }
  }
  resync(slot) {
    if (slot.resyncing) return;
    slot.resyncing = setTimeout(() => {
      slot.resyncing = null;
      if (this.closed) return;
      this.follow(slot.threadId, slot.hostId).catch(error => { this.lastError = error.message; });
    }, 1000);
    slot.resyncing.unref();
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const catalog = await this.tools.call('list_threads', { limit: this.config.discoveryLimit });
      const entries = [...(catalog.pinnedThreads || []), ...(catalog.threads || [])];
      const summary = entries.map(({ id, hostId, kind, status, title, isUnread }) => ({ id, hostId, kind, status, title, isUnread }));
      const signature = JSON.stringify(summary);
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.publish('threads.changed', { threads: summary, coverage: { recentLimit: this.config.discoveryLimit, includesPinned: true } });
      }
      this.lastCatalog = catalog; this.lastPollAt = new Date().toISOString(); this.lastError = null;
      const active = entries.filter(entry => entry.kind === 'codex' && ['active', 'running', 'waiting', 'needs_attention'].includes(entry.status));
      const activeKeys = new Set(active.map(entry => this.key(entry.id, entry.hostId || 'local')));
      for (const [key, slot] of this.subscriptions) {
        if (!activeKeys.has(key) && Date.now() - slot.usedAt > 15 * 60 * 1000 && !(slot.listeners > 0)) {
          this.ipc.unfollow(slot.threadId, slot.hostId, slot.owner); this.subscriptions.delete(key);
        }
      }
      const targets = new Map(active.map(entry => [this.key(entry.id, entry.hostId || 'local'), { threadId: entry.id, hostId: entry.hostId || 'local' }]));
      for (const [key, slot] of this.subscriptions) if (slot.stale) targets.set(key, slot);
      // Bounded concurrency; slow remote hosts cannot create an unbounded work queue.
      const list = [...targets.values()];
      for (let i = 0; i < list.length && !this.closed; i += 4) await Promise.allSettled(list.slice(i, i + 4).map(slot => this.follow(slot.threadId, slot.hostId)));
    } catch (error) { this.lastError = error.message; }
    finally { this.polling = false; }
  }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs); this.timer.unref(); }
  async interrupt(threadId, hostId, expectedTurnId) {
    const state = await this.state(threadId, hostId);
    if (!state.currentTurn || state.currentTurn.id !== expectedTurnId || state.currentTurn.status !== 'inProgress') throw new ApiError(409, 'turn_changed', 'The expected active turn is no longer current. Refresh state before interrupting.');
    const slot = this.subscriptions.get(this.key(threadId, hostId));
    const response = await this.ipc.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId }, slot.owner, hostId);
    return response.result;
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const slot of this.subscriptions.values()) { clearTimeout(slot.resyncing); this.ipc.unfollow(slot.threadId, slot.hostId, slot.owner); }
    this.ipc.close(); this.tools.close();
  }
}
