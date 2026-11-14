import { randomUUID } from 'node:crypto';
import { conversationControl, eventOrder, matchSources, now, recordKey, runtimeFailure, runtimeRecords as R } from './runtime-records.mjs';

/** Per-Bot inbox. The event is stored once; observation and each wait have independent processing positions. */
export class Inbox {
  constructor(store, botId) { this.store = store; this.botId = botId; }

  receive(delivery) {
    const { id, bot_id, event, match_sources = [], wait_refs = [], revision = 1 } = delivery;
    if (!id || !event?.id || bot_id !== this.botId || !Array.isArray(match_sources) || !Array.isArray(wait_refs))
      throw runtimeFailure('invalid_delivery', 'Delivery requires its original identity, event, Bot and routing facts', 400);
    return this.store.transaction(() => {
      const prior = this.store.getRecord(R.delivery, id);
      if (prior && prior.event_id !== event.id) throw runtimeFailure('delivery_conflict', 'Delivery identity belongs to another event');
      const waitIds = [], affected = new Set();
      for (const wait of wait_refs) {
        if (!wait?.id || wait.bot_id !== this.botId || !wait.run_id || !wait.conversation_id || !wait.call_id)
          throw runtimeFailure('invalid_wait', 'Call delivery requires the actual return relationship', 400);
        const original = this.store.getRecord(R.wait, wait.id);
        if (original && (original.run_id !== wait.run_id || original.call_id !== wait.call_id || original.conversation_id !== wait.conversation_id))
          throw runtimeFailure('wait_conflict', 'Wait identity belongs to another call or run');
        waitIds.push(wait.id);
        this.store.putRecord(R.wait, { ...original, ...wait, ...original?.status && { status: original.status },
          event_ids: [...new Set([...(original?.event_ids || []), event.id])] });
        const route = this.route(event.id, { wait_id: wait.id, conversation_id: wait.conversation_id, run_id: wait.run_id });
        if (route.state === 'pending' && this.run(wait.run_id)) {
          this.associate(wait.run_id, [route]);
          affected.add(wait.run_id);
        }
      }
      if (match_sources.length || wait_refs.length === 0) this.route(event.id, { match_sources });
      const saved = this.store.getRecord(R.event, event.id);
      const savedAt = prior?.received_at || now();
      this.store.putRecord(R.event, { id: event.id, event: saved?.event || event, received_at: saved?.received_at || savedAt });
      this.store.putRecord(R.delivery, { id, event_id: event.id, bot_id, state: 'received', received_at: savedAt, revision: Math.max(prior?.revision || 0, revision),
        match_sources: matchSources(prior?.match_sources || [], match_sources), wait_refs: [...new Set([...(prior?.wait_refs || []), ...waitIds])] });
      for (const runId of affected) if (this.run(runId).state === 'completed') this.putRun({ id: runId, state: 'waiting' });
      return this.receipt(id);
    });
  }

  route(eventId, patch) {
    const id = recordKey(eventId, patch.wait_id || 'observation');
    const existing = this.store.getRecord(R.route, id);
    return this.store.putRecord(R.route, { id, event_id: eventId, state: 'pending', ...existing, ...patch,
      match_sources: matchSources(existing?.match_sources || [], patch.match_sources || []) });
  }

  event(eventId) { return this.store.getRecord(R.event, eventId)?.event; }
  receipt(deliveryId) {
    const record = this.store.getRecord(R.delivery, deliveryId);
    return record && { accepted: record.state === 'received', state: record.state, delivery_id: record.id,
      event_id: record.event_id, received_at: record.received_at, revision: record.revision,
      processed: this.list(R.route, 'event_id', record.event_id).every(route => route.state !== 'pending') };
  }
  conversation(id) { return this.store.getRecord(R.conversation, id); }
  run(id) { return this.store.getRecord(R.run, id); }
  wait(id) { return this.store.getRecord(R.wait, id); }
  calls(runId) { return this.list(R.call, 'run_id', runId); }
  waits(runId) { return this.list(R.wait, 'run_id', runId); }
  runs(conversationId) { return this.list(R.run, 'conversation_id', conversationId); }

  list(kind, field, value) {
    return this.store.db.prepare('SELECT data FROM records WHERE kind=? AND json_extract(data,?)=? ORDER BY rowid')
      .all(kind, `$.${field}`, value).map(row => JSON.parse(row.data));
  }

  pending() {
    return this.list(R.route, 'state', 'pending').map(route => ({ ...route, event: this.event(route.event_id) }))
      .filter(route => route.event).sort((left, right) => eventOrder(left.event, right.event));
  }

  putConversation(values) {
    const original = this.conversation(values.id);
    return this.store.putRecord(R.conversation, { bot_id: this.botId, control: conversationControl(), input_revision: 0,
      created_at: now(), ...original, ...values, updated_at: now() });
  }

  putRun(values) {
    const original = this.run(values.id);
    return this.store.putRecord(R.run, { bot_id: this.botId, state: 'pending', pending_event_ids: [], injected_event_ids: [], processed_event_ids: [],
      route_ids: [], created_at: now(), ...original, ...values, updated_at: now() });
  }

  createRun(conversation, routes, values = {}) {
    return this.store.transaction(() => {
      const run = this.putRun({ id: randomUUID(), conversation_id: conversation.id, control_version: conversation.control.control_version, ...values });
      return this.associate(run.id, routes);
    });
  }

  associate(runId, routes) {
    return this.store.transaction(() => {
      const run = this.run(runId);
      const pending = new Set(run.pending_event_ids), linked = new Set(run.route_ids);
      for (const route of routes) {
        pending.add(route.event_id);
        linked.add(route.id);
        this.store.putRecord(R.route, { ...route, event: undefined, run_id: run.id, conversation_id: run.conversation_id });
      }
      return this.putRun({ id: run.id, pending_event_ids: [...pending], route_ids: [...linked] });
    });
  }

  recordInjection(runId, eventIds) {
    return this.store.transaction(() => {
      const run = this.run(runId);
      return this.putRun({ id: run.id, injected_event_ids: [...new Set([...run.injected_event_ids, ...eventIds])] });
    });
  }

  complete(runId, state, eventIds, boundaries = {}, canProcess = () => true) {
    return this.store.transaction(() => {
      const run = this.run(runId), injected = new Set(run.injected_event_ids), processed = new Set(run.processed_event_ids);
      for (const id of eventIds) if (injected.has(id)) processed.add(id);
      for (const id of run.route_ids) {
        const route = this.store.getRecord(R.route, id);
        if (!route || !processed.has(route.event_id) || route.state !== 'pending' || !canProcess(route)) continue;
        this.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now() });
        if (route.wait_id) {
          const wait = this.wait(route.wait_id);
          const event = this.event(route.event_id);
          if (wait) this.store.putRecord(R.wait, { ...wait, status: event?.status || 'processed',
            result_position: event?.result_position ?? event?.id, processed_event_ids: [...new Set([...(wait.processed_event_ids || []), route.event_id])] });
        }
      }
      return this.putRun({ id: run.id, state, processed_event_ids: [...processed], ...boundaries });
    });
  }

  transcript(runId) { return this.store.getRecord(R.transcript, runId)?.messages || []; }
  append(runId, message) {
    return this.store.transaction(() => {
      const previous = this.store.getRecord(R.transcript, runId);
      const messages = previous?.messages || [];
      this.store.putRecord(R.transcript, { ...previous, id: runId, messages: [...messages, message] });
    });
  }
}
