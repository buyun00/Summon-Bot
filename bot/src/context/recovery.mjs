const userMessage = value => ({ role: "user", content: [{ type: "text", text: JSON.stringify(value) }], timestamp: Date.now() });
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
      repaired.push(userMessage({ type: 'interruption', error: message.errorMessage || '上一轮模型输出中断，未形成有效答复。',
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
        repaired.push(userMessage({ type: 'recovered_observation', toolCallId: message.toolCallId,
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

