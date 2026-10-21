import { createHash } from 'node:crypto';

const kind = 'capability-updates';
const at = () => new Date().toISOString();
const failure = (status, message, code = 'CAPABILITY_UPDATE_CONFLICT') => Object.assign(new Error(message), { status, code });
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');

/** The external controller chooses versions; the Bot owns its safe task boundary.
 * Staged credentials stay in memory. Durable records contain only hashes and
 * public metadata; the private Bot config is the commit marker after a crash.
 */
export class CapabilityUpdates {
  constructor({ config, store, engine, emit, clean, persist }) {
    Object.assign(this, { config, store, engine, emit, clean, persist });
    this.pending = null; this.closed = false;
  }
  recover() {
    for (const record of this.store.listRecords(kind)) {
      if (!['preparing', 'ready'].includes(record.status)) continue;
      const committed = this.config.capabilityUpdateId === record.id && this.config.capabilityBindingRevision === record.bindingRevision && hash(this.config.tools) === record.toolsHash;
      this.save({ ...record, status: committed ? 'committed' : 'failed', recoveredAt: at(),
        ...(committed ? { committedAt: at() } : { error: { code: 'CAPABILITY_UPDATE_INTERRUPTED', message: 'Bot restarted before the capability update committed; prepare a new update ID' } }) });
    }
  }
  public(record) {
    if (!record) return null;
    const { payloadHash, toolsHash, ...value } = record;
    return value;
  }
  get(id) {
    const record = this.store.getRecord(kind, id);
    if (!record) throw failure(404, 'Unknown capability update', 'CAPABILITY_UPDATE_NOT_FOUND');
    return this.public(record);
  }
  save(record) {
    const value = this.store.putRecord(kind, { ...record, updatedAt: at() });
    this.emit(`capability.update.${value.status}`, this.public(value));
    return this.public(value);
  }
  prepare(input) {
    if (this.closed) throw failure(503, 'Bot is closing', 'BOT_STOPPING');
    if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 512 ||
        typeof input.bindingRevision !== 'string' || !input.bindingRevision || input.bindingRevision.length > 512 ||
        !Array.isArray(input.tools) || (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2000)) ||
        (input.bundledToolNames !== undefined && (!Array.isArray(input.bundledToolNames) || input.bundledToolNames.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) || new Set(input.bundledToolNames).size !== input.bundledToolNames.length))) {
      throw failure(400, 'Capability update requires id, bindingRevision and tools', 'INVALID_CAPABILITY_UPDATE');
    }
    const definitions = structuredClone(input.tools), bundledToolNames = input.bundledToolNames === undefined ? undefined : [...input.bundledToolNames];
    const payloadHash = hash({ tools: definitions, bindingRevision: input.bindingRevision, reason: input.reason || '', bundledToolNames });
    const previous = this.store.getRecord(kind, input.id);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw failure(409, 'Capability update ID belongs to another payload');
      return this.public(previous);
    }
    if (this.pending) throw failure(409, `Capability update ${this.pending.record.id} is already pending`);
    const gate = this.engine.holdTasks(), controller = new AbortController();
    const record = { id: input.id, bindingRevision: input.bindingRevision, previousBindingRevision: this.config.capabilityBindingRevision || null,
      status: 'preparing', reason: this.clean(input.reason || ''), payloadHash, toolsHash: hash(definitions),
      currentTools: [...this.engine.toolNames], proposedTools: [], createdAt: at() };
    const update = { record, definitions, bundledToolNames, gate, controller, staged: null, committing: false };
    this.pending = update;
    try { this.save(record); }
    catch (error) { this.pending = null; gate.release(); throw error; }
    // Never wait for the active task here: it may itself be requesting the update.
    update.preparation = this.stage(update);
    return this.public(record);
  }
  async stage(update) {
    try {
      update.staged = await this.engine.stageConfigured(update.definitions, update.controller.signal);
      if (update.bundledToolNames?.some(name => !update.staged.tools.some(tool => tool.name === name))) throw failure(400, 'bundledToolNames must be a subset of the staged configured tool names', 'INVALID_CAPABILITY_UPDATE');
      await update.gate.idle;
      update.controller.signal.throwIfAborted();
      if (this.pending !== update) return;
      update.record = { ...update.record, status: 'ready', proposedTools: update.staged.tools.map(tool => tool.name), readyAt: at() };
      this.save(update.record);
    } catch (error) {
      if (this.pending === update) {
        update.record = { ...update.record, status: 'failed', error: this.clean({ code: error.code || 'CAPABILITY_PREPARE_FAILED', message: error.message }), failedAt: at() };
        this.save(update.record); this.pending = null; update.gate.release();
      }
      await update.staged?.close();
    }
  }
  async commit(id) {
    const record = this.store.getRecord(kind, id);
    if (!record) throw failure(404, 'Unknown capability update', 'CAPABILITY_UPDATE_NOT_FOUND');
    if (record.status === 'committed') return this.public(record);
    const update = this.pending;
    if (!update || update.record.id !== id || update.record.status !== 'ready') throw failure(409, 'Capability update is not ready');
    if (update.committing) return update.commitment;
    update.committing = true;
    update.commitment = (async () => {
      try {
        // No task can start between the durable config write and in-memory swap.
        await this.persist({ tools: update.definitions, ...(update.bundledToolNames === undefined ? {} : { bundledToolNames: update.bundledToolNames }),
          capabilityBindingRevision: record.bindingRevision, capabilityUpdateId: id });
        const previous = this.engine.replaceConfigured(update.staged);
        update.staged = null;
        update.record = { ...update.record, status: 'committed', committedAt: at() };
        const result = this.save(update.record);
        this.pending = null; update.gate.release();
        await previous.close();
        return result;
      } finally { update.committing = false; }
    })();
    return update.commitment;
  }
  async abort(id, code = 'CAPABILITY_UPDATE_ABORTED') {
    const record = this.store.getRecord(kind, id);
    if (!record) throw failure(404, 'Unknown capability update', 'CAPABILITY_UPDATE_NOT_FOUND');
    if (record.status === 'failed') return this.public(record);
    const update = this.pending;
    if (!update || update.record.id !== id || record.status === 'committed' || update.committing) throw failure(409, 'Capability update cannot be aborted');
    update.controller.abort(new Error('Capability update aborted'));
    update.record = { ...update.record, status: 'failed', failedAt: at(), error: { code, message: 'Capability update did not commit; previous capabilities remain active' } };
    const result = this.save(update.record);
    this.pending = null; update.gate.release();
    // Preparation may be waiting for the active task; closing the staged client
    // does not cancel that task or touch its current capability clients.
    await update.staged?.close();
    return result;
  }
  async close() {
    this.closed = true;
    if (this.pending?.committing) await this.pending.commitment.catch(() => {});
    if (this.pending) await this.abort(this.pending.record.id, 'CAPABILITY_UPDATE_INTERRUPTED');
  }
}
