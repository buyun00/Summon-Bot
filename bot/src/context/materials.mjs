import { recordKey, refKey, sameRef, runtimeRecords as R } from '../storage/runtime-records.mjs';
import { textMessage } from './projection.mjs';

const scopeKinds = new Set(['bot', 'room', 'conversation', 'session']);
const isRef = (ref, kind) => typeof ref?.id === 'string' && ref.id && (kind ? ref.kind === kind : typeof ref.kind === 'string');
const refs = (values, predicate = isRef) => Array.isArray(values) ? values.filter(value => predicate(value)).sort((a, b) => refKey(a).localeCompare(refKey(b))) : [];
const positiveRevision = value => Number.isSafeInteger(value) && value > 0;

function parseIndex(file) {
  if (typeof file?.content !== 'string') return null;
  try {
    const index = JSON.parse(file.content);
    return Array.isArray(index?.items) ? index : null;
  } catch { return null; }
}

const itemIdentity = (file, item) => recordKey(file.id, item.id, item.revision ?? file.revision ?? 1);

export function isMaterialFact(message) {
  if (!message?.runtime_fact) return false;
  const text = message.content?.[0]?.text;
  return ['selected_material_revisions', 'material_index', 'selected_materials'].some(type => text?.startsWith(`{"type":"${type}",`));
}

export class MaterialRuntime {
  constructor(runtime) {
    this.runtime = runtime;
  }

  read(ref, context) {
    if (!isRef(ref, 'file')) return null;
    try { return this.runtime.platform.files.read(ref.id, context, undefined, 200); }
    catch (error) {
      if (![403, 404].includes(error.status)) this.runtime.emit('engine.material_unavailable', { ref });
      return null;
    }
  }

  readable(ref, context) {
    try { return this.runtime.platform.canReadReference(ref, context); }
    catch { return false; }
  }

  projectSourceRefs(rawRefs, context) {
    return refs(rawRefs).map(ref =>
      this.readable(ref, context) ? ref : { kind: ref.kind, id: ref.id, access: 'redacted' }
    );
  }

  snapshot(root, context, scope) {
    const head = this.read(root, context);
    if (!head) return { entries: [], issue: 'index_unavailable' };
    const rootIndex = parseIndex(head);
    if (!rootIndex) {
      if (typeof head.content === 'string' && head.content.trim()) {
        const applies = head.space && scopeKinds.has(head.space.kind) ? [head.space] : [{ kind: 'bot', id: context.actor.id }];
        if (scope && !scope.some(ref => applies.some(own => sameRef(own, ref)))) {
          return { entries: [], revision: head.revision, unavailable: new Set() };
        }
        const key = recordKey(head.id, 'plain', head.revision);
        return {
          entries: [{
            id: key,
            key,
            item_id: head.name || head.path || 'memory',
            index_ref: head.ref,
            index_revision: head.revision,
            selection_revision: head.revision,
            material_revision: head.revision,
            applies_to: applies,
            note: head.content,
            content: head.content,
            source_refs: this.projectSourceRefs(head.sources, context),
            author: head.author,
          }],
          revision: head.revision,
          unavailable: new Set(),
        };
      }
      return { entries: [], issue: 'index_unreadable', revision: head.revision };
    }

    const indexes = [[head, rootIndex]], unavailable = new Set();
    for (const ref of refs(rootIndex.shared_indexes, value => isRef(value, 'file'))) {
      if (ref.id === head.id) continue;
      const file = this.read(ref, context), index = parseIndex(file);
      if (!index) unavailable.add(ref.id);
      else if (!indexes.some(([entry]) => entry.id === file.id)) indexes.push([file, index]);
    }
    const entries = [];
    for (const [file, index] of indexes) {
      for (const row of index.items) {
        if (typeof row?.id !== 'string' || !row.id) continue;
        const itemRevision = positiveRevision(row.revision) ? row.revision : (file.revision || 1);
        const rawApplies = refs(row.applies_to, ref => isRef(ref) && scopeKinds.has(ref.kind));
        const applies = rawApplies.length ? rawApplies : (file.space && scopeKinds.has(file.space.kind) ? [file.space] : []);
        if (!applies.length || (scope && !scope.some(ref => applies.some(own => sameRef(own, ref))))) continue;
        const materialRef = isRef(row.material_ref, 'file') ? row.material_ref : null;
        const material = materialRef ? this.read(materialRef, context) : null;
        const sourceRefs = this.projectSourceRefs(row.source_refs ?? file.sources, context);
        const skillFile = this.read(row.skill?.ref, context);
        const skill = skillFile && typeof row.skill.name === 'string' && typeof row.skill.description === 'string'
          ? { name: row.skill.name, description: row.skill.description, ref: skillFile.ref, revision: skillFile.revision }
          : null;
        const note = typeof row.note === 'string' ? row.note : null;
        const identity = itemIdentity(file, { ...row, revision: itemRevision });
        const materialRevision = material?.revision ?? (materialRef ? null : itemRevision);
        const content = materialRef ? material?.content : note;
        entries.push({
          id: identity,
          key: identity,
          item_id: row.id,
          index_ref: file.ref,
          index_revision: file.revision,
          selection_revision: itemRevision,
          applies_to: applies,
          material_ref: materialRef,
          material_revision: materialRevision,
          note,
          content,
          source_refs: sourceRefs,
          ...(row.supersedes ? { supersedes: row.supersedes } : {}),
          ...(row.deprecated_note ? { deprecated_note: row.deprecated_note } : {}),
          ...(row.status ? { status: row.status } : {}),
          author: file.author,
          material_author: material?.author,
          material_truncated: Boolean(material?.next_cursor),
          skill,
        });
      }
    }
    return { entries, revision: head.revision, unavailable };
  }

  boundary(job) {
    const { inbox, conversation } = job;
    const context = this.runtime.platform.context(job.context());
    const bot = this.runtime.platform.getBot(inbox.botId);
    const sessionRecord = conversation.session_id
      ? this.runtime.platform.executions.record({ kind: 'session', id: conversation.session_id })
      : null;
    const isSharedSession = Boolean(sessionRecord?.sharing);
    const root = conversation.session_id
      ? (conversation.binding?.material_index_ref ?? bot.material_index_ref)
      : bot.material_index_ref;
    if (!root) return null;

    const scope = [
      ...(!isSharedSession ? [context.actor] : []),
      conversation.space,
      ...(sessionRecord?.project_room ? [sessionRecord.project_room] : []),
      { kind: 'conversation', id: conversation.id },
      ...(context.session ? [{ kind: 'session', id: context.session.id }] : []),
    ].filter(Boolean);

    const snapshot = this.snapshot(root, context, scope);
    if (snapshot.issue) return { fact: textMessage({ type: 'material_index', ref: root, status: snapshot.issue }) };

    const visible = snapshot.entries.map(item => ({
      key: item.id,
      ref: item.material_ref || item.index_ref,
      item_id: item.item_id,
      material_revision: item.material_revision,
      selection_revision: item.selection_revision,
      ...(item.skill?.revision ? { skill_revision: item.skill.revision } : {}),
      ...(item.material_revision === null ? { issue: 'material_unavailable' } : {}),
      source_refs: item.source_refs,
      applies_to: item.applies_to,
      owner: item.material_author || item.author,
      ...(item.skill ? { skill: item.skill } : {}),
      ...(item.supersedes ? { supersedes: item.supersedes } : {}),
      ...(item.deprecated_note ? { deprecated_note: item.deprecated_note } : {}),
      ...(item.status ? { status: item.status } : {}),
      note: item.material_ref ? (item.note || undefined) : item.note,
    }));

    if (!visible.length && !snapshot.unavailable?.size) return null;

    const fact = textMessage({
      type: 'selected_material_revisions',
      scope,
      index_ref: root,
      index_revision: snapshot.revision,
      entries: visible,
      ...(snapshot.unavailable?.size ? { unavailable_indexes: [...snapshot.unavailable].map(id => ({ kind: 'file', id })) } : {}),
    });
    return { fact };
  }

  inspectBot(bot, context = { actor: { kind: 'user', id: 'user' } }) {
    if (!bot?.material_index_ref) return [];
    try {
      const snapshot = this.snapshot(bot.material_index_ref, context, null);
      return (snapshot.entries || []).map(item => ({
        item_id: item.item_id,
        revision: item.selection_revision,
        material_revision: item.material_revision,
        index_ref: item.index_ref,
        index_revision: item.index_revision,
        material_ref: item.material_ref || null,
        applies_to: item.applies_to,
        note: item.note,
        source_refs: item.source_refs,
        ...(item.supersedes ? { supersedes: item.supersedes } : {}),
        ...(item.deprecated_note ? { deprecated_note: item.deprecated_note } : {}),
        ...(item.status ? { status: item.status } : {}),
      }));
    } catch {
      return [];
    }
  }
}
