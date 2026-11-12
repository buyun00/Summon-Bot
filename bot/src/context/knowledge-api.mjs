import { randomUUID } from 'node:crypto';
import { environmentScopeId } from './environment.mjs';

export async function writeKnowledgeDocument(maintenance, store, input, { environment = false } = {}) {
  const id = environment ? environmentScopeId : input.id || `note:${randomUUID()}`;
  let scope = store.getRecord('knowledge_scope', id);
  if (!environment && id === environmentScopeId) throw Object.assign(new Error('The environment index is maintained from catalog observations'), { status: 403 });
  if (environment && (!input.workId || !input.source || !input.text?.trim() || !Array.isArray(input.resourceIds)))
    throw new TypeError('An environment index requires its initialization work, sources and Markdown');
  if (environment && scope?.revision > 0 && scope.kind !== 'native-environment')
    throw Object.assign(new Error('The environment index identity already belongs to another document'), { status: 409 });
  if (environment && scope?.revision > 0 && scope.environmentWorkId === input.workId) {
    const current = await maintenance.read(id);
    if (current.content.trim()) return { id, revision: scope.revision, title: scope.title };
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== (scope?.revision || 0)) throw Object.assign(new Error('Knowledge changed; reload the document'), { status: 409 });
  const content = input.text ?? input.content;
  if (typeof content !== 'string') throw new TypeError('Knowledge content is required');
  if (!scope) {
    scope = { id, file: `${randomUUID()}.md`, title: input.title || '用户补充', workId: null, conversationId: null,
      sessions: [], cursors: {}, revision: 0, pending: false, createdAt: new Date().toISOString() };
    store.putRecord('knowledge_scope', scope);
  }
  const source = !environment && input.source ? `\n\n来源：${typeof input.source === 'string' ? input.source : JSON.stringify(input.source)}` : '';
  const document = environment ? { kind: 'native-environment', environmentWorkId: input.workId, source: input.source, resourceIds: input.resourceIds } : undefined;
  const scopeRefs = environment ? [`work:${input.workId}`, ...input.resourceIds.map(id => `catalog:${id}`)] : undefined;
  await maintenance.write(id, `${content}${source}`, { title: input.title, expectedRevision: input.expectedRevision, document, scopeRefs });
  const current = store.getRecord('knowledge_scope', id);
  if (environment) return { id, revision: current.revision, title: current.title };
  return { id, revision: current.revision, title: current.title, text: (await maintenance.read(id, { length: 100000 })).content };
}
