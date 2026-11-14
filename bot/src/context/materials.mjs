import { randomUUID } from 'node:crypto';
import { now, recordKey, refKey, sameRef, runtimeRecords as R } from '../storage/runtime-records.mjs';
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

function resultObject(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (text.startsWith('```json\n') && text.endsWith('\n```')) text = text.slice(8, -4);
  try {
    const result = JSON.parse(text);
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch { return null; }
}

const itemIdentity = (file, item) => recordKey(file.id, item.id, item.revision);
const itemScope = (item, botId) => [{ kind: 'bot', id: botId }, ...item.applies_to];
const contentOf = message => message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');

export class MaterialRuntime {
  constructor(runtime) { this.runtime = runtime; this.nextScan = new Map(); }

  read(ref, context) {
    if (!isRef(ref, 'file')) return null;
    try { return this.runtime.platform.files.read(ref.id, context); }
    catch (error) { if ([403, 404].includes(error.status)) return null; throw error; }
  }

  snapshot(inbox, root, context, scope) {
    const head = this.read(root, context);
    if (!head) return { entries: [], issue: 'index_unavailable' };
    const rootIndex = parseIndex(head);
    if (!rootIndex) return { entries: [], issue: 'index_unreadable', revision: head.revision };
    const indexes = [[head, rootIndex]];
    for (const ref of refs(rootIndex.shared_indexes, value => isRef(value, 'file'))) {
      if (ref.id === head.id) continue;
      const file = this.read(ref, context), index = parseIndex(file);
      if (index && !indexes.some(([entry]) => entry.id === file.id)) indexes.push([file, index]);
    }
    const entries = [];
    for (const [file, index] of indexes) {
      for (const row of index.items) {
        if (typeof row?.id !== 'string' || !row.id || !positiveRevision(row.revision)) continue;
        const applies = refs(row.applies_to, ref => isRef(ref) && scopeKinds.has(ref.kind));
        if (!applies.length || scope && !scope.some(ref => applies.some(own => sameRef(own, ref)))) continue;
        const material = this.read(row.material_ref, context);
        const materialRef = isRef(row.material_ref, 'file') ? row.material_ref : null;
        const sourceRefs = refs(row.source_refs).filter(ref => this.runtime.platform.canReadReference(ref, context));
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
        const content = materialRef ? material?.content : note;
        entries.push({ ...selection, note, author: file.author, index_revision: file.revision, source_refs: sourceRefs,
          material_revision: materialRevision, material_author: material?.author, content, material_truncated: Boolean(material?.next_cursor), skill, key });
      }
    }
    return { entries, revision: head.revision };
  }

  async boundary(job) {
    const { inbox, conversation, runId } = job;
    const run = inbox.run(runId);
    if (run.material_batch_id) {
      const batch = inbox.store.getRecord(R.batch, run.material_batch_id);
      const context = this.runtime.platform.context(job.context());
      const bot = this.runtime.platform.getBot(inbox.botId);
      const snapshot = sameRef(bot.material_index_ref, batch.root) ? this.snapshot(inbox, batch.root, context).entries : [];
      const items = batch.items.filter(item => snapshot.some(latest => latest.key === item.key));
      return [textMessage({ type: 'selected_materials', batch_id: batch.id, target: batch.target,
        items: items.map(({ item_id, index_ref, material_ref, material_revision, note, content, source_refs }) =>
          ({ item_id, index_ref, material_ref, material_revision, note, content, source_refs })),
        instructions: 'Read the target and consolidate the selected material if useful. Return a JSON object. For items that needed no change, include {"no_change":{"item_ids":["actual IDs"],"observed_target_revision":1}}. For items incorporated by saving the target, include {"processed_item_ids":["actual IDs"],"call_id":"the save_file call ID","target_revision":2}. Both sets can be present. Include only the supplied items you actually handled. Tool calls use their ordinary parameters.',
      }, Date.parse(batch.created_at))];
    }
    const context = this.runtime.platform.context(job.context());
    const bot = this.runtime.platform.getBot(inbox.botId);
    const root = conversation.session_id ? conversation.binding.material_index_ref : bot.material_index_ref;
    if (!root) return [];
    const scope = [context.actor, conversation.space, { kind: 'conversation', id: conversation.id }];
    if (context.session) scope.push({ kind: 'session', id: context.session.id });
    const snapshot = this.snapshot(inbox, root, context, scope);
    if (snapshot.issue) return [textMessage({ type: 'material_index', ref: root, status: snapshot.issue })];
    const id = recordKey(conversation.id, root.id);
    const old = inbox.store.getRecord(R.materialView, id);
    const current = snapshot.entries.map(item => ({ key: item.id, material_revision: item.material_revision,
      selection_revision: item.selection_revision, skill_revision: item.skill?.revision, issue: item.issue || (item.material_revision === null ? 'material_unavailable' : null) }));
    const previous = new Map((old?.entries || []).map(item => [item.key, item]));
    const entries = snapshot.entries.map((item, index) => {
      const state = current[index], before = previous.get(state.key);
      return { ...state, ref: item.material_ref || item.index_ref, item_id: item.item_id, source_refs: item.source_refs,
        owner: item.material_author || item.author, skill: item.skill, note: item.material_ref ? undefined : item.note,
        ...(before && JSON.stringify(state) !== JSON.stringify(before) ? { previous_material_revision: before.material_revision } : {}) };
    });
    const removed = (old?.entries || []).filter(item => !current.some(entry => entry.key === item.key)).map(item => item.key);
    if (JSON.stringify(current) !== JSON.stringify(old?.entries)) {
      inbox.store.putRecord(R.materialView, { id, entries: current, revision: snapshot.revision, recorded_at: now() });
    }
    const visible = [];
    let budget = 48000;
    for (const entry of entries) {
      const projected = { ...entry, note: entry.note?.slice(0, 6500), ...(entry.note?.length > 6500 ? { note_truncated: true } : {}) };
      const cost = JSON.stringify(projected).length;
      if (visible.length >= 64 || cost > budget) break;
      budget -= cost;
      visible.push(projected);
    }
    return [textMessage({ type: 'selected_material_revisions', scope, index_ref: root, index_revision: snapshot.revision,
      entries: visible, removed, additional_entries: Math.max(0, entries.length - visible.length) }, Date.parse(old?.recorded_at) || Date.now())];
  }

  async consider(inbox, bot) {
    if (this.runtime.draining || this.runtime.closed || !bot.material_index_ref || this.nextScan.get(bot.id) > Date.now() || inbox.pending().length ||
        [...this.runtime.active.values()].some(job => job.inbox === inbox)) return;
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
      const activeInScope = inbox.store.listRecords(R.conversation).some(conversation => conversation.kind !== 'material' &&
        seed.applies_to.some(scope => sameRef(scope, conversation.space) || scope.kind === 'conversation' && scope.id === conversation.id ||
          scope.kind === 'session' && scope.id === conversation.session_id) &&
        inbox.runs(conversation.id).some(run => ['running', 'pending', 'waiting', 'retry', 'interrupted'].includes(run.state)));
      if (activeInScope) continue;
      const target = this.read(seed.target_ref, context);
      if (!positiveRevision(target?.revision)) continue;
      const prior = inbox.store.listRecords(R.batch).find(batch => ['partial', 'interrupted'].includes(batch.state) && batch.target.id === target.id &&
        batch.target.revision === target.revision && batch.items.some(item => item.key === seed.key) && Date.parse(batch.retry_at) > Date.now());
      if (prior) continue;
      let budget = 22000;
      const items = [];
      for (const item of selected.filter(item => sameRef(item.target_ref, seed.target_ref) &&
        JSON.stringify(item.applies_to) === JSON.stringify(seed.applies_to))) {
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
    const batch = job.inbox.store.getRecord(R.batch, run.material_batch_id);
    if (batch.result) return { text: batch.result, eventIds: [] };
    const last = job.inbox.transcript(run.id).at(-1);
    if (last?.role === 'assistant' && last.stopReason === 'stop' && typeof contentOf(last) === 'string')
      return { text: contentOf(last), model: last.model, response_id: last.responseId, eventIds: [] };
    return null;
  }

  defer(job) {
    const { inbox, runId } = job;
    const batchId = inbox.run(runId).material_batch_id;
    if (!batchId) return;
    const batch = inbox.store.getRecord(R.batch, batchId);
    if (batch.state === 'prepared') inbox.store.putRecord(R.batch, { ...batch, state: 'interrupted', retry_at: new Date(Date.now() + 300000).toISOString() });
  }

  async finish(job, result) {
    const { inbox, runId } = job;
    const run = inbox.run(runId);
    if (!run.material_batch_id) return;
    let batch = inbox.store.getRecord(R.batch, run.material_batch_id);
    if (['committed', 'partial'].includes(batch.state)) return;
    if (batch.state !== 'result_saved') batch = inbox.store.putRecord(R.batch, { ...batch, state: 'result_saved', result: result.text });
    const payload = resultObject(batch.result);
    const ids = value => new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
    const processed = ids(payload?.processed_item_ids), unchanged = ids(payload?.no_change?.item_ids);
    const context = this.runtime.platform.context(job.context());
    const target = this.read(batch.target.ref, context);
    const bot = this.runtime.platform.getBot(inbox.botId);
    const current = sameRef(bot.material_index_ref, batch.root) ? this.snapshot(inbox, batch.root, context).entries : [];
    const pendingWrite = inbox.calls(runId).some(call => call.tool === 'save_file' && call.args?.path === batch.target.path &&
      sameRef(call.args?.space, batch.target.space) && ['prepared', 'submitting', 'unknown', 'submitted'].includes(call.state));
    const call = typeof payload?.call_id === 'string' ? inbox.store.getRecord(R.call, payload.call_id) : null;
    let applied;
    if (processed.size && call?.run_id === runId && call.tool === 'save_file') applied = await this.runtime.readFor(job, { kind: 'call', id: call.id });
    if (call?.state === 'unknown' && !applied) throw Object.assign(new Error('The original material write result is not yet available'), { code: 'call_result_unknown', status: 503 });
    const revision = payload?.target_revision;
    const savedRevision = positiveRevision(revision) && this.runtime.platform.store.get('platform-file-revisions', recordKey(batch.target.id, revision));
    const written = applied?.status === 'completed' && applied.result?.id === batch.target.id &&
      applied.result?.revision === revision && target && savedRevision?.call_id === call?.id;
    const noChange = target?.revision === payload?.no_change?.observed_target_revision &&
      (target?.revision === batch.target.revision || written && target.revision === revision) && !pendingWrite;
    job.check();
    inbox.store.transaction(() => {
      const consumed = [];
      for (const item of batch.items) {
        if (!current.some(entry => entry.key === item.key)) continue;
        const outcome = written && processed.has(item.item_id) ? 'written' : noChange && unchanged.has(item.item_id) ? 'no_change' : null;
        if (!outcome) continue;
        const value = { id: item.key, bot_id: inbox.botId, item_id: item.item_id, index_ref: item.index_ref, target_ref: batch.target.ref,
          target_revision: outcome === 'written' ? revision : target.revision, scope: itemScope(item, inbox.botId), selection_revision: item.selection_revision,
          material_revision: item.material_revision, material_ref: item.material_ref, outcome, call_id: outcome === 'written' ? call.id : null,
          batch_id: batch.id, run_id: runId, consumed_at: now() };
        inbox.store.putRecord(R.consumption, value);
        consumed.push(item.key);
      }
      const complete = consumed.length === batch.items.length;
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
        [item.index_ref, item.target_ref, item.material_ref].filter(Boolean).every(ref => this.runtime.platform.canReadReference(ref, context)))
        .map(record => ({ ...record, kind: 'material_consumption' })));
    }
    return results;
  }
}
