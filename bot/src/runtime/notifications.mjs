export function notificationParts(record) {
  const content = String(record.content || ''), parts = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + 15000);
    const line = content.lastIndexOf('\n', end);
    if (end < content.length && line > offset + 7500) end = line + 1;
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    parts.push({ roomId: record.roomId, content: content.slice(offset, end), replyTo: record.replyTo,
      clientId: offset ? `${record.id}:part:${parts.length + 1}` : record.id, workId: record.workId, purpose: 'fyi', eventType: 'work_result',
      sourceRefs: record.sourceRefs || [{ type: 'work', workId: record.workId, taskId: record.taskId }] });
    offset = end;
  }
  return parts;
}
