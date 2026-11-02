import { randomUUID } from 'node:crypto';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection } from '../pi/core/session-manager.mjs';
import { convertToLlm } from '../pi/core/messages.mjs';
import { estimateProjectedContextTokens } from '../pi/core/compaction/compaction.mjs';

const byteSize = value => Buffer.byteLength(JSON.stringify(value));

// IDs describe immutable positions in the original transcript. Checkpoints never delete messages.
export function sessionEntries(session) {
  const entries = [];
  let parentId = null;
  const checkpoints = (session.checkpoints || []).filter(item => !item.invalidated);
  const changes = [...checkpoints.map(item => ({ ...item, type: 'compaction' })), ...(session.contextEdits || [])];
  changes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.timestamp).localeCompare(String(b.timestamp)));
  for (let index = 0; index < session.messages.length; index++) {
    const id = `m:${index}`;
    entries.push({ type: 'message', id, parentId, message: session.messages[index] }); parentId = id;
    for (const change of changes.filter(item => item.afterMessageCount === index + 1)) {
      entries.push({ ...change, parentId }); parentId = change.id;
    }
  }
  return entries;
}

export function projectSession(session, { useCheckpoints = true } = {}) {
  const entries = sessionEntries(useCheckpoints ? session : { ...session, checkpoints: [] });
  const projection = buildSessionProjection(entries);
  const messages = convertToLlm(projection.messages);
  const source = estimateProjectedContextTokens(projection, entries);
  return { entries, projection, messages, bytes: byteSize({ messages }), tokens: source.tokens,
    estimate: { ...source, method: 'pi-projected-context' } };
}

export class SessionContext {
  constructor({ sessions, clean = value => value, onCheckpoint = () => {} }) {
    Object.assign(this, { sessions, clean, onCheckpoint }); this.entryIds = new WeakMap();
  }

  project(sessionId) {
    const view = projectSession(this.sessions.getSession(sessionId));
    for (const entry of view.projection.entries) for (const message of entry.messages) this.entryIds.set(message, entry.sourceEntry.id);
    return view;
  }

  recordMessage(sessionId, message, runId) {
    const current = this.sessions.getSession(sessionId);
    this.entryIds.set(message, `m:${current.messages.length}`);
    return this.sessions.saveSession(this.clean({ ...current, schemaVersion: 3,
      messages: [...current.messages, message], lastTaskId: runId }));
  }

  sessionManager(sessionId, { runId, model, signal } = {}) {
    const owner = this;
    let preparedRevision;
    const order = session => Math.max(0, ...(session.checkpoints || []).map(item => item.order || 0),
      ...(session.contextEdits || []).map(item => item.order || 0)) + 1;
    return {
      getBranch() { const session = owner.sessions.getSession(sessionId); preparedRevision = session.revision; return sessionEntries(session); },
      getEntries() { return sessionEntries(owner.sessions.getSession(sessionId)); },
      getEntry(id) { return this.getEntries().find(entry => entry.id === id); },
      buildSessionProjection() { return owner.project(sessionId).projection; },
      idForMessage(message) { return owner.entryIds.get(message); },
      appendContextEdit(targetId, replacement) {
        signal?.throwIfAborted();
        const session = owner.sessions.getSession(sessionId);
        if (!sessionEntries(session).some(entry => entry.id === targetId)) throw new Error('Recovery target no longer exists');
        const entry = { type: 'context_edit', id: `edit:${randomUUID()}`, targetId, replacement,
          timestamp: new Date().toISOString(), afterMessageCount: session.messages.length, order: order(session), runId };
        owner.sessions.saveSession(owner.clean({ ...session, schemaVersion: 3,
          contextEdits: [...(session.contextEdits || []), entry], expectedRevision: session.revision }));
        return entry.id;
      },
      appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) {
        signal?.throwIfAborted();
        if (typeof summary !== 'string' || !summary.trim()) throw new Error('Compaction produced an empty summary');
        const session = owner.sessions.getSession(sessionId);
        if (preparedRevision !== session.revision) throw new Error('Session changed while summarizing; original history retained');
        const before = owner.project(sessionId);
        const checkpoint = owner.clean({ id: `compact:${randomUUID()}`, summary, firstKeptEntryId, tokensBefore, details, usage, fromHook,
          timestamp: new Date().toISOString(), afterMessageCount: session.messages.length, order: order(session),
          systemMessage: getCurrentSystemMessage(before.projection.messages), runId, model: model?.id,
          estimateBefore: before.estimate, bytesBefore: before.bytes });
        const candidate = { ...session, schemaVersion: 3, checkpoints: [...(session.checkpoints || []), checkpoint] };
        const rebuilt = projectSession(candidate);
        checkpoint.estimatedTokensAfter = rebuilt.tokens; checkpoint.bytesAfter = rebuilt.bytes;
        owner.sessions.saveSession({ ...candidate, expectedRevision: session.revision });
        owner.onCheckpoint(sessionId, checkpoint);
        return checkpoint.id;
      },
    };
  }

  historyTool(sessionId) {
    return { name: 'read_session_history', label: '读取会话原文', description: 'Read original messages and tool receipts from this Bot and session, including history covered by a lossy checkpoint. Read-only; never replays tools. Use query to locate evidence then start to paginate.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, start: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0, description: 'Character offset in a large original message; use start=index and limit=1 to read successive fragments.' } }, additionalProperties: false },
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const session = this.sessions.getSession(sessionId);
        const start = args.start ?? 0, limit = args.limit ?? 5, offset = args.offset ?? 0;
        if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0) throw new Error('无效历史分页参数');
        const found = session.messages.map((message, index) => ({ index, message })).filter(item => item.index >= start &&
          (!args.query || (!(item.message.role === 'toolResult' && item.message.toolName === 'read_session_history') && JSON.stringify(item.message).includes(args.query))));
        const messages = []; let bytes = 0;
        for (const item of found.slice(0, limit)) {
          const raw = JSON.stringify(item.message);
          const fragmentOffset = args.offset === undefined && args.query ? Math.max(0, raw.indexOf(args.query) - 1000) : offset;
          // Explicit preview for very large receipts; original remains in SQLite/API audit.
          const value = raw.length > 6000 || offset ? { index: item.index, role: item.message.role, toolName: item.message.toolName,
            preview: raw.slice(fragmentOffset, fragmentOffset + 6000), truncated: fragmentOffset > 0 || fragmentOffset + 6000 < raw.length,
            offset: fragmentOffset, nextOffset: fragmentOffset + 6000 < raw.length ? fragmentOffset + 6000 : null, fullCharacters: raw.length } : item;
          bytes += byteSize(value); if (bytes > 32000 && messages.length) break;
          messages.push(value);
        }
        const details = { sessionId, total: session.messages.length, messages, next: messages.length ? messages.at(-1).index + 1 : null, hasMore: found.length > messages.length };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } };
  }
}
