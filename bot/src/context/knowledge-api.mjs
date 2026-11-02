import { randomUUID } from 'node:crypto';

export async function writeKnowledgeDocument(maintenance, store, input) {
  const id = input.id || `note:${randomUUID()}`;
  let scope = store.getRecord('knowledge_scope', id);
  if (input.expectedRevision !== undefined && input.expectedRevision !== (scope?.revision || 0)) throw Object.assign(new Error('Knowledge changed; reload the document'), { status: 409 });
  const content = input.text ?? input.content;
  if (typeof content !== 'string') throw new TypeError('Knowledge content is required');
  if (!scope) {
    scope = { id, file: `${randomUUID()}.md`, title: input.title || '用户补充', workId: null, conversationId: null,
      sessions: [], cursors: {}, revision: 0, pending: false, createdAt: new Date().toISOString() };
    store.putRecord('knowledge_scope', scope);
  }
  const source = input.source ? `\n\n来源：${typeof input.source === 'string' ? input.source : JSON.stringify(input.source)}` : '';
  await maintenance.write(id, `${content}${source}`, { title: input.title, expectedRevision: input.expectedRevision });
  const current = store.getRecord('knowledge_scope', id);
  return { id, revision: current.revision, title: current.title, text: (await maintenance.read(id, { length: 100000 })).content };
}
