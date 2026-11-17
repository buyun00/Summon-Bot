export function receiveMessages(message) {
  if (message.type === 'system' && message.subtype === 'init') return { sessionId: message.session_id };
  if (message.type === 'system' && message.subtype === 'permission_denied')
    return { progress: 'The CLI denied a tool permission request', phase: 'permission_denied' };
  if (message.type === 'assistant' && !message.parent_tool_use_id) {
    const parts = Array.isArray(message.message?.content) ? message.message.content : [];
    const text = parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    const tools = parts.filter(part => part.type === 'tool_use').map(part => ({
      itemId: part.id, tool: part.name, command: part.input?.command, phase: 'call',
    }));
    return { progress: text || tools[0]?.tool, itemId: message.message?.id, tools };
  }
  if (message.type === 'user' && Array.isArray(message.message?.content)) {
    const results = message.message.content.filter(part => part.type === 'tool_result');
    const failures = results.filter(part => part.is_error === true);
    const tools = results.map(part => ({ itemId: part.tool_use_id, phase: 'result', status: part.is_error === true ? 'failed' : 'completed',
      ...(part.is_error === true ? { text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content) } : {}) }));
    if (failures.length) return { progress: failures.map(part => typeof part.content === 'string' ? part.content : JSON.stringify(part.content)).join('\n'),
      phase: 'tool_failed', itemId: failures[0].tool_use_id, tools };
    if (tools.length) return { tools };
  }
  if (message.type === 'result') return { sessionId: message.session_id, terminal: true,
    reason: message.stop_reason ?? message.subtype, text: message.result,
    ...(Array.isArray(message.permission_denials) && message.permission_denials.length ? {
      progress: 'CLI permission denied: ' + message.permission_denials.map(item => item?.tool_name || 'tool').join(', '), phase: 'permission_denied',
    } : {}),
    ...(message.is_error || message.subtype && message.subtype !== 'success' ?
      { error: message.errors?.join?.('\n') || message.result || message.subtype || 'The CLI reported an unsuccessful result' } : {}) };
  return null;
}
