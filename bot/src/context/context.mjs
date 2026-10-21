import { randomUUID } from 'node:crypto';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection } from '../pi/core/session-manager.mjs';
import { convertToLlm } from '../pi/core/messages.mjs';
import { compact, prepareCompaction, estimateProjectedContextTokens, shouldCompact } from '../pi/core/compaction/compaction.mjs';
import { contextSettings, NO_RETRY } from '../agent/model.mjs';

const byteSize = value => Buffer.byteLength(JSON.stringify(value));

// IDs describe immutable positions in the original transcript. Checkpoints never delete messages.
export function sessionEntries(session) {
  const entries = [];
  let parentId = null;
  const checkpoints = (session.checkpoints || []).filter(item => !item.invalidated);
  for (let index = 0; index < session.messages.length; index++) {
    const id = `m:${index}`;
    entries.push({ type: 'message', id, parentId, message: session.messages[index] }); parentId = id;
    for (const checkpoint of checkpoints.filter(item => item.afterMessageCount === index + 1)) {
      entries.push({ ...checkpoint, type: 'compaction', parentId }); parentId = checkpoint.id;
    }
  }
  return entries;
}

export function projectSession(session, { useCheckpoints = true } = {}) {
  const entries = sessionEntries(useCheckpoints ? session : { ...session, checkpoints: [] });
  const projection = buildSessionProjection(entries);
  const messages = convertToLlm(projection.messages);
  const source = estimateProjectedContextTokens(projection, entries);
  // chars/4 alone understates Chinese and JSON tool schemas. This is an estimate, not a tokenizer.
  const conservativeTokens = Math.ceil(byteSize(messages) / 2) + messages.length * 16;
  return { entries, projection, messages, bytes: byteSize({ messages }), tokens: Math.max(source.tokens, conservativeTokens),
    estimate: { ...source, conservativeTokens, method: 'max(provider-usage-plus-tail,utf8-json-bytes/2+message-overhead)' } };
}

export class SessionContext {
  constructor({ sessions, config, clean = value => value, onCheckpoint = () => {} }) { Object.assign(this, { sessions, config, clean, onCheckpoint }); }

  async prepare(sessionId, { model, signal, streamFn, runId }) {
    signal?.throwIfAborted();
    const settings = contextSettings(this.config, model);
    let session = this.sessions.getSession(sessionId);
    let view = projectSession(session, { useCheckpoints: this.config.agentUseCheckpoints !== false });
    const maxBytes = this.config.agentSessionMaxBytes ?? 384000;
    const exceeds = value => shouldCompact(value.tokens, model.contextWindow, { ...settings, enabled: true }) || value.bytes > maxBytes;
    if (!exceeds(view)) return view;
    if (!settings.enabled || maxBytes < 4096) throw new Error(`会话上下文达到容量上限 (${view.bytes}/${maxBytes} 字节，估算 ${view.tokens} token)。完整历史已保留；压缩未执行。`);
    if (this.config.agentUseCheckpoints === false) throw new Error('已关闭压缩重建；请启用 checkpoint 或在新会话继续，完整历史已保留');
    let preparation = prepareCompaction(view.entries, settings);
    if (!preparation) throw new Error('当前输入无法在保留完整工具调用的条件下压缩；请缩小请求。完整历史已保留');
    // Pi's token cut can keep one oversized assistant message. Before billing a
    // summary, try the newest safe boundary when that retained tail cannot fit.
    const tailSize = prepared => {
      const index = view.projection.entries.findIndex(entry => entry.sourceEntry.id === prepared.firstKeptEntryId);
      const tail = convertToLlm(view.projection.entries.slice(index).flatMap(entry => entry.messages));
      return byteSize([getCurrentSystemMessage(session.messages), ...tail]);
    };
    if (Math.ceil(tailSize(preparation) / 2) + model.maxTokens > model.contextWindow - settings.reserveTokens || tailSize(preparation) > maxBytes) {
      preparation = prepareCompaction(view.entries, { ...settings, keepRecentTokens: 1 }) || preparation;
    }
    if (Math.ceil(tailSize(preparation) / 2) >= model.contextWindow - settings.reserveTokens || tailSize(preparation) >= maxBytes) throw new Error('当前输入或完整工具结果超过保留容量，无法安全压缩；原文已保留');
    // Keep the newest user input if there has been no assistant/tool response to it yet.
    const last = session.messages.at(-1);
    const firstKept = Number(preparation.firstKeptEntryId.replace(/^m:/, ''));
    if (last?.role === 'user' && (!Number.isInteger(firstKept) || firstKept > session.messages.length - 1)) throw new Error('压缩切点不能丢弃当前输入');
    const beforeCount = session.messages.length;
    const beforeCheckpoints = JSON.stringify(session.checkpoints || []);
    const instructions = 'Preserve user decisions and permissions, exact paths, IDs and critical observed values. Distinguish confirmed tool receipts from failed, interrupted or resultKnown=false operations. Never infer completion or replay operations. Keep pending work and task and sender context. This is a lossy checkpoint; read_session_history can recover original observations by index or query.';
    const result = await compact(preparation, model, undefined, undefined, instructions, signal, 'off', streamFn, undefined, NO_RETRY, undefined, sessionId);
    signal?.throwIfAborted();
    if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('压缩没有返回有效摘要；历史未改动');
    const checkpoint = this.clean({ ...result, id: `compact:${randomUUID()}`, timestamp: new Date().toISOString(), afterMessageCount: beforeCount,
      systemMessage: getCurrentSystemMessage(session.messages), runId, model: model.id,
      tokensBefore: view.tokens, estimateBefore: view.estimate, bytesBefore: view.bytes });
    const candidate = { ...session, checkpoints: [...(session.checkpoints || []), checkpoint] };
    const rebuilt = projectSession(candidate);
    if (exceeds(rebuilt) || rebuilt.bytes >= view.bytes) throw new Error(`压缩后仍超过容量或未减少上下文 (${rebuilt.bytes}/${maxBytes} 字节，估算 ${rebuilt.tokens} token)；未提交摘要，原历史已保留`);
    checkpoint.estimatedTokensAfter = rebuilt.tokens;
    checkpoint.bytesAfter = rebuilt.bytes;
    this.sessions.transaction(() => {
      signal?.throwIfAborted();
      const latest = this.sessions.getSession(sessionId);
      if (latest.messages.length !== beforeCount || JSON.stringify(latest.checkpoints || []) !== beforeCheckpoints) throw new Error('压缩期间会话已变化，未覆盖新历史');
      session = this.sessions.saveSession({ ...latest, schemaVersion: Math.max(latest.schemaVersion || 1, 2), checkpoints: [...(latest.checkpoints || []), checkpoint] });
    });
    this.onCheckpoint(sessionId, checkpoint);
    return projectSession(session);
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
