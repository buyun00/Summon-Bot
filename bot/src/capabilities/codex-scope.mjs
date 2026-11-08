// Built only from authenticated task sources and durable local work. Model
// arguments, Desktop project names and global thread discovery grant nothing.
export function codexScope(actor, task, store, source, workspace) {
  const works = store.listRecords('works').filter(work => task.workId ? work.id === task.workId :
    work.sources?.length && work.sources.every(item => source.roomId ? item.roomId === source.roomId :
      !item.roomId && item.source === source.source && item.conversationId === source.conversationId));
  const original = source.actor === 'user' ? source.input?.trigger?.content : '';
  const threadGrants = typeof original === 'string' && /关联|附着|接入|继续|使用|读取|查看|沿用|attach|continue|read|use|inspect/i.test(original)
    ? [...new Set(original.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [])] : [];
  return { botId: actor, workIds: works.map(work => work.id),
    projectIds: [...new Set(works.flatMap(work => [work.project?.nativeProjectId,
      work.executor?.target?.type === 'project' ? work.executor.target.projectId : null]).filter(Boolean))],
    directories: [...new Set([workspace, ...works.map(work => work.executor?.target?.cwd)].filter(Boolean))],
    threadGrants, sourceMessageId: source.replyTo || source.messageId };
}
