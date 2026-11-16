export function receiveMessages(message) {
  if (message.type === 'system' && message.subtype === 'init') return { sessionId: message.session_id };
  if (message.type === 'system' && message.subtype === 'permission_denied')
    return { progress: 'The CLI denied a tool permission request', phase: 'permission_denied' };
  if (message.type === 'assistant' && !message.parent_tool_use_id) {
    const parts = Array.isArray(message.message?.content) ? message.message.content : [];
    const text = parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    return { progress: text || parts.find(part => part.type === 'tool_use')?.name, itemId: message.message?.id };
  }
  if (message.type === 'user' && Array.isArray(message.message?.content)) {
    const failures = message.message.content.filter(part => part.type === 'tool_result' && part.is_error === true);
    if (failures.length) return { progress: failures.map(part => typeof part.content === 'string' ? part.content : JSON.stringify(part.content)).join('\n'),
      phase: 'tool_failed', itemId: failures[0].tool_use_id };
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
