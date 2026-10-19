import { createHash } from 'node:crypto';
import { getCurrentTools, toToolDeclaration } from '@earendil-works/pi-ai';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textOf = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const finalReplyOf = messages => {
  const last = messages.findLast(message => message.role === 'assistant');
  if (!last) return '';
  try {
    const value = JSON.parse(textOf(last).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return typeof value.reply === 'string' ? value.reply.trim() : '';
  } catch { return ''; }
};
const userMessage = value => ({ role: 'user', content: [{ type: 'text', text: JSON.stringify(value) }], timestamp: Date.now() });
export const sessionIdFor = (botId, roomId) => `agent-session:${hash([botId, roomId])}`;

// The durable transcript must remain valid after a crash at any event boundary.
// These observations explicitly describe uncertainty; they never repeat a tool.
export function repairTranscript(messages, resolveResult = () => null) {
  const repaired = [];
  const recoveryRecords = [];
  let pending = new Map();
  const finishPending = () => {
    for (const { call, assistant } of pending.values()) repaired.push(resolveResult(call, assistant) || { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify({ interrupted: true, resultKnown: false,
        error: '此工具调用没有持久保存的完整结果：可能未执行，也可能执行后中断，结果未确认。运行器没有重放它。先读取实际状态核对，不得据此声称成功。' }) }],
      isError: true, timestamp: Date.now(), recovery: true });
    pending = new Map();
  };
  for (const message of messages || []) {
    if (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)) {
      finishPending();
      recoveryRecords.push({ reason: 'incomplete_assistant', message });
      repaired.push(userMessage({ type: 'relay_interruption', error: message.errorMessage || '上一轮模型输出中断，未形成有效答复。',
        instruction: '中断的模型输出不是已执行操作；已持久化的真实工具观察保留在上文。不要自动重做副作用。' }));
      continue;
    }
    if (message.role === 'toolResult') {
      const call = pending.get(message.toolCallId);
      if (call) {
        repaired.push({ ...message, toolName: message.toolName || call.call.name });
        pending.delete(message.toolCallId);
      } else {
        finishPending();
        recoveryRecords.push({ reason: 'orphan_tool_result', message });
        repaired.push(userMessage({ type: 'relay_recovered_observation', toolCallId: message.toolCallId,
          instruction: '以下是缺失原调用消息的已保存工具观察，不能把它作为当前工具调用成功的证据，也不得自动重放。', observation: message }));
      }
      continue;
    }
    finishPending();
    repaired.push(message);
    if (message.role === 'assistant') {
      for (const call of (message.content || []).filter(part => part.type === 'toolCall')) pending.set(call.id, { call, assistant: message });
    }
  }
  finishPending();
  return { messages: repaired, recoveryRecords };
}

export class AgentSessions {
  constructor(store, clean = value => value) { this.store = store; this.clean = clean; }
  save(session) { return this.store.save('agentSessions', this.clean(session)); }

  resultResolver(runId) {
    const run = runId && this.store.get('agentRuns', runId);
    if (!run) return () => null;
    const assistants = (run.messages || []).filter(message => message.role === 'assistant');
    const tools = this.store.list('toolRuns').filter(tool => tool.runId === runId);
    return (call, assistant) => {
      // A call ID may be reused across turns. Require the exact owning assistant
      // and its turn as well as the run; ambiguous records stay explicitly unknown.
      const matches = assistants.map((message, index) => ({ message, turn: index + 1 }))
        .filter(item => JSON.stringify(item.message) === JSON.stringify(assistant));
      if (matches.length !== 1) return null;
      const records = tools.filter(tool => tool.turn === matches[0].turn && tool.toolCallId === call.id && tool.name === call.name &&
        ['completed', 'failed'].includes(tool.status) && Array.isArray(tool.result?.content));
      if (records.length !== 1) return null;
      const record = records[0];
      return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: record.result.content,
        ...(record.result.details !== undefined ? { details: record.result.details } : {}), isError: record.status === 'failed',
        timestamp: Date.parse(record.finishedAt) || Date.now(), recoveredFromToolRunId: record.id };
    };
  }

  repair(session) {
    const result = repairTranscript(session.messages, this.resultResolver(session.lastRunId));
    if (JSON.stringify(result.messages) === JSON.stringify(session.messages)) return session;
    return this.save({ ...session, messages: result.messages,
      recoveryRecords: [...(session.recoveryRecords || []), ...result.recoveryRecords] });
  }

  load({ botId, roomId, prompt, tools }) {
    const id = sessionIdFor(botId, roomId);
    const declarations = tools.map(toToolDeclaration);
    const promptHash = hash({ prompt, tools: declarations });
    let session = this.store.get('agentSessions', id);
    if (!session) {
      const previous = this.store.list('agentRuns').filter(run => !run.sessionId && run.botId === botId && run.roomId === roomId);
      const messages = [{ role: 'system', content: '', sections: { relay: prompt }, toolsAdded: declarations, timestamp: 0 }];
      const consumed = new Set();
      const recoveryRecords = [];
      for (const run of previous) {
        const raw = Array.isArray(run.messages) ? run.messages : [];
        for (const message of raw) {
          if (message.role !== 'user') continue;
          try {
            const context = JSON.parse(textOf(message));
            for (const item of context.messages || []) if (item.id) consumed.add(item.id);
            if (context.trigger?.id) consumed.add(context.trigger.id);
          } catch { /* A plain user message remains part of the native transcript. */ }
        }
        const repaired = repairTranscript(raw.filter(message => message.role !== 'system'), this.resultResolver(run.id));
        messages.push(...repaired.messages);
        recoveryRecords.push(...repaired.recoveryRecords.map(item => ({ ...item, runId: run.id })));
        const reply = finalReplyOf(raw);
        const delivered = run.jobId && this.store.get('messages', `reply:${run.jobId}`);
        if (run.status === 'completed' && run.jobId && reply && (!delivered || delivered.content.trim() === reply)) consumed.add(`reply:${run.jobId}`);
      }
      session = this.save({ id, schemaVersion: 1, botId, roomId, messages, consumedRoomMessageIds: [...consumed],
        dynamicContextHash: null, promptHash, lastRunId: null, migratedRunIds: previous.map(run => run.id), recoveryRecords });
    }
    session = this.repair(session);
    if (session.promptHash !== promptHash) {
      const removed = getCurrentTools(session.messages).filter(tool => !declarations.some(current => current.name === tool.name)).map(tool => ({ name: tool.name }));
      session = this.save({ ...session, promptHash, messages: [...session.messages, { role: 'system', content: '',
        sections: { relay: prompt }, toolsAdded: declarations, ...(removed.length ? { toolsRemoved: removed } : {}), timestamp: Date.now() }] });
    }
    return session;
  }

  prepare(session, context, { job, workspace, projectRoot, recovery }) {
    const consumed = new Set(session.consumedRoomMessageIds || []);
    const messages = (context.messages || []).filter(message => !consumed.has(message.id));
    const dynamic = Object.fromEntries(['bot', 'memories', 'nodes', 'edges', 'colleagues', 'works', 'summary'].map(key => [key, context[key] ?? (key === 'summary' ? '' : [])]));
    const dynamicContextHash = hash(dynamic);
    const payload = { type: 'relay_turn', messages, trigger: context.trigger, round: context.round || job.round || 1,
      instruction: context.instruction || '回应本次触发消息，沿用上文真实工具结果，不要重复已完成操作。',
      ...(session.dynamicContextHash !== dynamicContextHash ? { contextUpdate: dynamic } : {}),
      ...(context.dmResult ? { dmResult: context.dmResult } : {}),
      ...(recovery?.length ? { recovery: { instruction: '这是显式重试。先核对已有工具观察和实际文件，不盲目重做写入、命令或协作动作。参数明确截断的命令不可重放。', tools: recovery } } : {}),
      ...(!session.messages.some(message => message.role === 'user') ? { workspace, projectRoot } : {}) };
    return { message: userMessage(payload), roomMessageIds: messages.map(message => message.id).filter(Boolean), dynamicContextHash };
  }

  append(sessionId, message, { runId, consumedRoomMessageIds = [], dynamicContextHash } = {}) {
    const session = this.store.get('agentSessions', sessionId);
    // Keep malformed/error responses in the run audit; replace them with an explicit
    // interruption observation in the resumable transcript, never an empty assistant.
    const failedAssistant = message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason);
    const appended = failedAssistant ? userMessage({ type: 'relay_interruption', error: message.errorMessage || '模型响应中断，未形成有效答复。',
      instruction: '没有自动重试。已保存的真实工具观察仍有效，未确认的操作应先检查现场。' }) : message;
    return this.save({ ...session, messages: [...session.messages, appended], lastRunId: runId || session.lastRunId,
      consumedRoomMessageIds: [...new Set([...(session.consumedRoomMessageIds || []), ...consumedRoomMessageIds])],
      ...(dynamicContextHash ? { dynamicContextHash } : {}),
      ...(failedAssistant ? { recoveryRecords: [...(session.recoveryRecords || []), { reason: 'incomplete_assistant', runId, message }] } : {}) });
  }

  complete(sessionId, jobId, reply) {
    const session = this.store.get('agentSessions', sessionId);
    // Social may replace an empty DM answer with an actual colleague quotation.
    // That generated room message is new evidence and must be consumed next turn.
    if (typeof reply !== 'string' || !reply.trim()) return session;
    return this.save({ ...session, consumedRoomMessageIds: [...new Set([...(session.consumedRoomMessageIds || []), `reply:${jobId}`])] });
  }
}
