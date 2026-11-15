import { randomUUID } from 'node:crypto';
import { now, recordKey, refKey, sameRef, runtimeFailure, runtimeRecords as R } from '../storage/runtime-records.mjs';
import { textMessage } from './projection.mjs';

const scopeKinds = new Set(['bot', 'room', 'conversation', 'session']);
const isRef = (ref, kind) => typeof ref?.id === 'string' && ref.id && (kind ? ref.kind === kind : typeof ref.kind === 'string');
const refs = (values, predicate = isRef) => Array.isArray(values) ? values.filter(value => predicate(value)).sort((a, b) => refKey(a).localeCompare(refKey(b))) : [];
const positiveRevision = value => Number.isSafeInteger(value) && value > 0;

function parseIndex(file) {
  if (typeof file?.content !== 'string' || file.next_cursor) return null;
  try {
    const index = JSON.parse(file.content);
    return Array.isArray(index?.items) ? index : null;
  } catch { return null; }
}

const itemIdentity = (file, item) => recordKey(file.id, item.id, item.revision);
const itemScope = (item, botId) => [{ kind: 'bot', id: botId }, ...item.applies_to];
const contentOf = message => message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');

export function isMaterialFact(message) {
  if (!message.runtime_fact) return false;
  const text = message.content[0]?.text;
  return ['selected_material_revisions', 'material_index', 'selected_materials'].some(type => text?.startsWith(`{"type":"${type}",`));
}

export class MaterialRuntime {
  constructor(runtime) { this.runtime = runtime; this.nextScan = new Map(); }

  read(ref, context) {
    if (!isRef(ref, 'file')) return null;
    try { return this.runtime.platform.files.read(ref.id, context); }
    catch (error) {
      if (![403, 404].includes(error.status)) this.runtime.emit('engine.material_unavailable', { ref });
      return null;
    }
  }

  readable(ref, context) {
    try { return this.runtime.platform.canReadReference(ref, context); }
    catch { return false; }
  }

  snapshot(inbox, root, context, scope) {
    const head = this.read(root, context);
    if (!head) return { entries: [], issue: 'index_unavailable' };
    const rootIndex = parseIndex(head);
    if (!rootIndex) return { entries: [], issue: 'index_unreadable', revision: head.revision };
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
        if (typeof row?.id !== 'string' || !row.id || !positiveRevision(row.revision)) continue;
        const applies = refs(row.applies_to, ref => isRef(ref) && scopeKinds.has(ref.kind));
        if (!applies.length || scope && !scope.some(ref => applies.some(own => sameRef(own, ref)))) continue;
        const material = this.read(row.material_ref, context);
        const materialRef = isRef(row.material_ref, 'file') ? row.material_ref : null;
        const sourceRefs = refs(row.source_refs).filter(ref => this.readable(ref, context));
        const targetRef = isRef(row.target_ref, 'file') ? row.target_ref : null;
        const skillFile = this.read(row.skill?.ref, context);
        const skill = skillFile && typeof row.skill.name === 'string' && typeof row.skill.description === 'string' ?
          { name: row.skill.name, description: row.skill.description, ref: skillFile.ref, revision: skillFile.revision } : null;
        const note = typeof row.note === 'string' ? row.note.slice(0, 24000) : null;
        const selected = row.selected === true && Boolean(targetRef);
        const selection = { id: itemIdentity(file, row), item_id: row.id, index_ref: file.ref, selection_revision: row.revision,
          applies_to: applies, material_ref: materialRef, declared_revision: row.material_revision ?? null,
          note: typeof row.note === 'string' ? row.note : null, selected, target_ref: targetRef,
          source_refs: refs(row.source_refs), skill_ref: isRef(row.skill?.ref, 'file') ? row.skill.ref : null };
        const prior = inbox.store.getRecord(R.selection, selection.id);
        const signature = JSON.stringify(selection);
        if (prior && prior.signature !== signature) {
          entries.push({ ...selection, issue: 'selection_revision_conflict' });
          continue;
        }
        if (!prior) inbox.store.putRecord(R.selection, { id: selection.id, signature });
        const materialRevision = material?.revision ?? (materialRef ? null : row.revision);
        const key = recordKey(file.id, row.id, row.revision, materialRef?.id ?? null, materialRevision, itemScope(selection, inbox.botId).map(refKey), targetRef?.id ?? null);
        const content = materialRef ? material?.content : selection.note;
        entries.push({ ...selection, note, author: file.author, index_revision: file.revision, source_refs: sourceRefs,
          material_revision: materialRevision, material_author: material?.author, content, material_truncated: Boolean(material?.next_cursor), skill, key });
      }
    }
    return { entries, revision: head.revision, unavailable };
  }

  boundary(job) {
    const { inbox, conversation, runId } = job;
    const run = inbox.run(runId);
    const context = this.runtime.platform.context(job.context());
    const bot = this.runtime.platform.getBot(inbox.botId);
    if (run.material_batch_id) {
      const batch = inbox.store.getRecord(R.batch, run.material_batch_id);
      const snapshot = sameRef(bot.material_index_ref, batch.root) ? this.snapshot(inbox, batch.root, context).entries : [];
      const latest = new Map(snapshot.map(item => [item.key, item]));
      const items = batch.items.filter(item => !inbox.store.getRecord(R.consumption, item.key)).map(item => latest.get(item.key)).filter(Boolean);
      return { fact: textMessage({ type: 'selected_materials', batch_id: batch.id, target: batch.target,
        items: items.map(({ item_id, index_ref, material_ref, material_revision, note, content, source_refs }) =>
          ({ item_id, index_ref, material_ref, material_revision, note, content, source_refs })),
        instructions: 'Read the target and consolidate the selected material. When you save the target, list the item IDs you incorporated in save_file.material_items. To record that specific items need no edits, call save_file for the target with material_items, the revision you read, and content_or_source set to {"no_change":true}. Your final reply can be ordinary text.',
      }, Date.parse(batch.created_at)) };
    }
    const root = conversation.session_id ? conversation.binding.material_index_ref : bot.material_index_ref;
    const scope = [context.actor, conversation.space, { kind: 'conversation', id: conversation.id }];
    if (context.session) scope.push({ kind: 'session', id: context.session.id });
    const snapshot = root ? this.snapshot(inbox, root, context, scope) : { entries: [], revision: null };
    if (snapshot.issue) return { fact: textMessage({ type: 'material_index', ref: root, status: snapshot.issue }) };

    const id = conversation.id;
    // Earlier snapshots could advance during assembly. Only trust revisions found in the sent transcript.
    const old = inbox.store.getRecord(R.materialView, id) || this.sentPosition(inbox, runId);
    if (!root && !old) return null;
    const previous = new Map((old?.entries || []).map(item => [item.key, item]));
    const currentKeys = new Set(snapshot.entries.map(item => item.id));
    const isRemoved = key => !currentKeys.has(key) && !snapshot.unavailable?.has(JSON.parse(key)[0]);
    const newlyRemoved = [...previous.keys()].filter(isRemoved);
    const priorRemovals = old?.run_id === runId ? old.removed : [];
    const removed = [...new Set([...newlyRemoved, ...(priorRemovals || []).filter(isRemoved)])].slice(0, 64);
    if (!root && !removed.length && !old?.index_ref) return null;

    const pending = [], unchanged = [];
    for (const item of snapshot.entries) {
      const state = { key: item.id, material_revision: item.material_revision, selection_revision: item.selection_revision,
        skill_revision: item.skill?.revision, issue: item.issue || (item.material_revision === null ? 'material_unavailable' :
          item.material_truncated ? 'material_incomplete' : null) };
      const before = previous.get(state.key);
      const revised = !before || before.material_revision !== state.material_revision || before.skill_revision !== state.skill_revision || before.issue !== state.issue;
      let priorRevision;
      if (before && before.material_revision !== state.material_revision) priorRevision = before.material_revision;
      else if (old?.run_id === runId) priorRevision = before?.previous_material_revision;
      if (priorRevision !== undefined) state.previous_material_revision = priorRevision;
      const note = item.material_ref ? undefined : item.note?.slice(0, 6500);
      const projection = { ...state, ref: item.material_ref || item.index_ref, item_id: item.item_id, source_refs: item.source_refs,
        applies_to: item.applies_to, owner: item.material_author || item.author, skill: item.skill, note,
        ...(note && note.length < item.note.length ? { note_truncated: true } : {}) };
      (revised ? pending : unchanged).push({ state, projection });
    }

    const visible = [];
    let budget = 48000;
    for (const { state, projection } of [...pending, ...unchanged]) {
      const cost = JSON.stringify(projection).length;
      if (visible.length >= 64 || cost > budget) break;
      budget -= cost;
      visible.push(projection);
      previous.set(state.key, state);
    }
    for (const key of removed) previous.delete(key);
    const record = { id, run_id: runId, index_ref: root ?? null, revision: snapshot.revision, entries: [...previous.values()], removed };
    const fact = textMessage({ type: 'selected_material_revisions', scope, index_ref: record.index_ref, index_revision: snapshot.revision,
      entries: visible, removed, additional_entries: snapshot.entries.length - visible.length,
      ...(snapshot.unavailable?.size ? { unavailable_indexes: [...snapshot.unavailable].map(id => ({ kind: 'file', id })) } : {}) });
    return { fact, record: JSON.stringify(old) === JSON.stringify(record) ? undefined : record };
  }

  sentPosition(inbox, runId) {
    const text = inbox.transcript(runId).findLast(message => isMaterialFact(message) &&
      message.content[0].text.startsWith('{"type":"selected_material_revisions",'))?.content[0].text;
    if (!text) return null;
    const { entries, removed, index_ref } = JSON.parse(text);
    return { run_id: runId, entries: entries.map(({ key, material_revision, selection_revision, skill_revision, issue, previous_material_revision }) =>
      ({ key, material_revision, selection_revision, skill_revision, issue, previous_material_revision })), removed, index_ref };
  }

  async consider(inbox, bot, foreground) {
    if (this.runtime.draining || this.runtime.closed || !bot.material_index_ref || this.nextScan.get(bot.id) > Date.now() ||
        [...this.runtime.active.values()].some(job => job.inbox === inbox && job.conversation.kind === 'material')) return;
    this.nextScan.set(bot.id, Date.now() + 15000);
    const current = inbox.store.listRecords(R.batch).some(batch => ['prepared', 'result_saved'].includes(batch.state) &&
      ['pending', 'running', 'waiting', 'interrupted', 'retry'].includes(inbox.run(batch.run_id)?.state));
    if (current) return;
    const actor = { kind: 'bot', id: bot.id };
    const context = this.runtime.platform.principalContext(actor);
    const { entries } = this.snapshot(inbox, bot.material_index_ref, context);
    const selected = entries.filter(item => item.selected && item.key && !item.material_truncated && typeof item.content === 'string' &&
      !item.issue && !inbox.store.getRecord(R.consumption, item.key));
    for (const seed of selected) {
      const activeInScope = foreground.some(conversation => seed.applies_to.some(scope =>
        sameRef(scope, actor) || sameRef(scope, conversation.space) ||
        scope.kind === 'conversation' && scope.id === conversation.id || scope.kind === 'session' && scope.id === conversation.session_id));
      if (activeInScope) continue;
      const target = this.read(seed.target_ref, context);
      if (!positiveRevision(target?.revision)) continue;
      const prior = inbox.store.listRecords(R.batch).find(batch => ['partial', 'interrupted'].includes(batch.state) && batch.target.id === target.id &&
        batch.target.revision === target.revision && batch.items.some(item => item.key === seed.key) && Date.parse(batch.retry_at) > Date.now());
      if (prior) continue;
      // Batch smaller items together and give a single larger item its own turn.
      let budget = Math.max(22000, seed.content.length + 300);
      const items = [];
      for (const item of [seed, ...selected.filter(item => item !== seed && sameRef(item.target_ref, seed.target_ref) &&
        JSON.stringify(item.applies_to) === JSON.stringify(seed.applies_to))]) {
        if (item.content.length + 300 > budget || items.length >= 12 || items.some(value => value.item_id === item.item_id)) continue;
        budget -= item.content.length + 300;
        items.push(item);
      }
      if (!items.length) continue;
      const conversation = this.runtime.register(inbox, inbox.putConversation({ id: randomUUID(), kind: 'material', space: actor, owner: actor }));
      inbox.store.transaction(() => {
        const id = randomUUID();
        const run = inbox.createRun(conversation, [], { material_batch_id: id });
        inbox.store.putRecord(R.batch, { id, state: 'prepared', created_at: now(), root: bot.material_index_ref, run_id: run.id,
          target: { id: target.id, ref: target.ref, revision: target.revision, path: target.path, space: target.space },
          control_version: conversation.control.control_version, items });
      });
      this.runtime.wake();
      return;
    }
  }

  recovered(job) {
    const run = job.inbox.run(job.runId);
    if (!run.material_batch_id) return null;
    this.finish(job, false);
    const batch = job.inbox.store.getRecord(R.batch, run.material_batch_id);
    const last = job.inbox.transcript(run.id).at(-1);
    if (batch.state === 'committed') return { text: contentOf(last), model: last?.model, response_id: last?.responseId, eventIds: [] };
    if (batch.result) return { text: batch.result, eventIds: [] };
    if (last?.role === 'assistant' && last.stopReason === 'stop' && typeof contentOf(last) === 'string')
      return { text: contentOf(last), model: last.model, response_id: last.responseId, eventIds: [] };
    return null;
  }

  defer(job) {
    const { inbox, runId } = job;
    const batchId = inbox.run(runId).material_batch_id;
    if (!batchId) return;
    this.finish(job, false);
    const batch = inbox.store.getRecord(R.batch, batchId);
    if (batch.state === 'prepared') inbox.store.putRecord(R.batch, { ...batch, state: 'interrupted', retry_at: new Date(Date.now() + 300000).toISOString() });
  }

  prepareSave(args, context) {
    const noChange = args.content_or_source?.no_change === true;
    const job = context.origin && this.runtime.active.get(context.origin.conversation_id);
    const run = job && job.runId === context.origin.run_id ? job.inbox.run(job.runId) : null;
    const batch = run?.material_batch_id && job.inbox.store.getRecord(R.batch, run.material_batch_id);
    const explicit = noChange || args.material_items !== undefined;
    if (!batch || !sameRef(args.space, batch.target.space) || args.path !== batch.target.path) {
      if (explicit) throw runtimeFailure('material_target_unavailable', 'The requested File is outside this material selection', 409);
      return null;
    }
    const selected = new Set(args.material_items ?? []);
    if (!explicit && batch.items.length === 1) selected.add(batch.items[0].item_id);
    if (!selected.size) {
      if (explicit) throw runtimeFailure('material_items_required', 'Identify the selected material items handled by this operation', 400);
      return null;
    }
    const bot = this.runtime.platform.getBot(job.inbox.botId);
    const current = sameRef(bot.material_index_ref, batch.root) ? this.snapshot(job.inbox, batch.root, context).entries : [];
    const currentKeys = new Set(current.filter(item => item.selected && !item.issue && !item.material_truncated && typeof item.content === 'string').map(item => item.key));
    const items = batch.items.filter(item => selected.has(item.item_id) && currentKeys.has(item.key));
    if (items.length !== selected.size && explicit)
      throw runtimeFailure('material_selection_changed', 'One or more selected material items are no longer available', 409);
    return items.length ? { batch_id: batch.id, target: batch.target, item_keys: items.map(item => item.key), no_change: noChange } : null;
  }

  finish(job, final = true) {
    const { inbox, runId } = job;
    const run = inbox.run(runId);
    if (!run.material_batch_id) return;
    const batch = inbox.store.getRecord(R.batch, run.material_batch_id);
    if (['committed', 'partial'].includes(batch.state)) return;
    const platform = this.runtime.platform.store;
    const actions = new Map();
    for (const local of inbox.calls(runId)) {
      if (local.tool !== 'save_file') continue;
      const call = platform.get('platform-calls', local.id);
      if (call?.status !== 'completed' || call.origin?.run_id !== runId || call.result?.id !== batch.target.id ||
          call.material?.batch_id !== batch.id || !positiveRevision(call.result.revision)) continue;
      const revision = call.result.revision;
      const { outcome, item_keys } = call.material;
      if (outcome === 'written') {
        if (platform.get('platform-file-revisions', recordKey(batch.target.id, revision))?.call_id !== call.id) continue;
      } else if (outcome !== 'no_change' || call.result.status !== 'no_change') continue;
      for (const key of item_keys) actions.set(key, { outcome, revision, call_id: call.id });
    }
    inbox.store.transaction(() => {
      const consumed = [];
      for (const item of batch.items) {
        if (inbox.store.getRecord(R.consumption, item.key)) { consumed.push(item.key); continue; }
        const action = actions.get(item.key);
        if (!action) continue;
        const value = { id: item.key, bot_id: inbox.botId, item_id: item.item_id, index_ref: item.index_ref, target_ref: batch.target.ref,
          target_revision: action.revision, scope: itemScope(item, inbox.botId), selection_revision: item.selection_revision,
          material_revision: item.material_revision, material_ref: item.material_ref, outcome: action.outcome, call_id: action.call_id,
          batch_id: batch.id, run_id: runId, consumed_at: now() };
        inbox.store.putRecord(R.consumption, value);
        consumed.push(item.key);
      }
      const complete = consumed.length === batch.items.length;
      if (!complete && !final) return;
      inbox.store.putRecord(R.batch, { ...batch, state: complete ? 'committed' : 'partial', consumed,
        finished_at: now(), retry_at: complete ? null : new Date(Date.now() + 300000).toISOString() });
    });
  }

  async view(scope, context, id) {
    if (context.session) return [];
    const botIds = context.actor.kind === 'user' ? this.runtime.platform.manager.list().map(bot => bot.id) : [context.actor.id];
    const results = [];
    for (const botId of botIds) {
      const bot = this.runtime.platform.getBot(botId);
      if ((bot.workspaceProfileId ?? null) !== (context.workspaceProfileId ?? null)) continue;
      const inbox = await this.runtime.inbox(botId, { create: false });
      if (!inbox) continue;
      const candidates = id ? [inbox.store.getRecord(R.consumption, id)].filter(Boolean) : inbox.store.listRecords(R.consumption);
      results.push(...candidates.filter(item => (!scope || item.scope?.some(ref => sameRef(ref, scope)) || sameRef(scope, item.target_ref)) &&
        [item.index_ref, item.target_ref, item.material_ref].filter(Boolean).every(ref => this.readable(ref, context)))
        .map(record => ({ ...record, kind: 'material_consumption' })));
    }
    return results;
  }
}
