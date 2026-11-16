import { assertRevision, idOf, identity, keyOf, reject, sameIdentity, sameRef } from './contract.mjs';
import { waitRecords } from './calls.mjs';

export const wakeupRecords = 'platform-wakeups';
export const deliveryRecords = 'platform-deliveries';
const roomBaseId = (botId, roomId) => keyOf('room_base', botId, roomId);
const unique = (values, key) => [...new Map(values.map(value => [key(value), value])).values()];
const handledWaitStates = new Set(['processed', 'cancelled', 'access_revoked']);

export class Deliveries {
  constructor({ store, resources, emit, canReadEvent, canReadWait, canReadReference, manager }) {
    Object.assign(this, { store, resources, emit, canReadEvent, canReadWait, canReadReference, manager });
    store.db.exec(`CREATE INDEX IF NOT EXISTS platform_delivery_status ON records (json_extract(data,'$.status')) WHERE kind='platform-deliveries';
      CREATE INDEX IF NOT EXISTS platform_delivery_event ON records (json_extract(data,'$.event.id')) WHERE kind='platform-deliveries'`);
    this.returningRecords = store.db.prepare(`SELECT data FROM records WHERE kind='platform-deliveries'
      AND json_extract(data,'$.status') IN ('pending','unknown') AND COALESCE(json_extract(data,'$.retry_at'),0)<=?
      AND (json_extract(data,'$.status')='unknown' OR COALESCE(json_array_length(data,'$.wait_refs'),0)>0) ORDER BY rowid`);
    this.pendingRecords = store.db.prepare(`SELECT data FROM records WHERE kind='platform-deliveries'
      AND json_extract(data,'$.status')='pending' AND COALESCE(json_extract(data,'$.retry_at'),0)<=?
      AND COALESCE(json_array_length(data,'$.wait_refs'),0)=0 ORDER BY rowid LIMIT ?`);
    this.eventRecords = store.db.prepare(`SELECT data FROM records WHERE kind='platform-deliveries' AND json_extract(data,'$.event.id')=? ORDER BY rowid`);
  }

  deliveriesFor(eventId) { return this.eventRecords.all(eventId).map(row => JSON.parse(row.data)); }

  roomMembers(roomId) { return this.store.get('rooms', roomId)?.members ?? []; }

  ensureBase(botId, roomId) {
    const id = roomBaseId(botId, roomId);
    const previous = this.store.get(wakeupRecords, id);
    if (previous && previous.member_active !== false) return previous;
    return this.store.save(wakeupRecords, { id, bot_id: botId, rule: { kind: 'room_base', room: roomId, mode: 'all' },
      member_active: true, enabled: true, revision: (previous?.revision ?? 0) + 1 });
  }

  removeBase(botId, roomId) {
    const id = roomBaseId(botId, roomId);
    const wakeup = this.store.get(wakeupRecords, id);
    if (wakeup && wakeup.member_active !== false) {
      this.store.save(wakeupRecords, { id, member_active: false, enabled: false, revision: wakeup.revision + 1 });
    }
    for (const delivery of this.store.list(deliveryRecords)) {
      if (delivery.bot_id === botId && delivery.event.roomId === roomId && !delivery.wait_refs?.length && delivery.status === 'pending') {
        this.store.save(deliveryRecords, { id: delivery.id, status: 'access_revoked' });
      }
    }
  }

  canManage(botId, actor) { return this.manager.canConfigure(actor, this.manager.get(botId)); }

  ruleUsable(rule, botId) {
    return (!rule.room || this.roomMembers(rule.room).includes(botId));
  }

  list(context, scope) {
    return this.store.list(wakeupRecords).filter(wakeup => {
      const bot = this.store.get('platform-bots', wakeup.bot_id);
      if (!bot || (bot.workspaceProfileId ?? null) !== (context.workspaceProfileId ?? null) || wakeup.member_active === false ||
          !this.ruleUsable(wakeup.rule, wakeup.bot_id) || !this.manager.canConfigure(context.actor, bot)) return false;
      if (scope?.kind === 'bot') return wakeup.bot_id === scope.id;
      if (scope?.kind === 'room') return wakeup.rule.room === scope.id;
      return !scope;
    }).map(wakeup => ({ ...wakeup, kind: 'wakeup' }));
  }

  set(args, context, callId) {
    const botId = idOf(args.bot, 'bot');
    const bot = this.manager.get(botId);
    if ((bot.workspaceProfileId ?? null) !== (context.workspaceProfileId ?? null) || !this.canManage(botId, context.actor)) {
      reject('wakeup_forbidden', 'Wakeup changes are unavailable for this Bot', 403);
    }
    if (context.session) reject('wakeup_forbidden', 'This Session has no Bot subscription configuration authority', 403);
    const current = args.id ? this.store.get(wakeupRecords, args.id) : null;
    if (args.id && (!current || current.bot_id !== botId || current.member_active === false)) reject('wakeup_not_found', 'Wakeup is unavailable', 404);
    if (current) assertRevision(current.revision, args.revision);
    else if (args.revision !== undefined) assertRevision(null, args.revision);
    if (!args.event_or_time && (!current || args.enabled === undefined)) reject('invalid_wakeup', 'Specify a Wakeup rule or change enabled');
    const rule = { ...(args.event_or_time || current.rule) };
    const targetContext = { actor: { kind: 'bot', id: botId }, workspaceProfileId: bot.workspaceProfileId ?? null };
    if (rule.room) {
      rule.room = idOf(rule.room, 'room');
      if (!this.roomMembers(rule.room).includes(context.actor.id) || !this.ruleUsable(rule, botId)) {
        reject('wakeup_forbidden', 'Room membership is required for this Wakeup', 403);
      }
    }
    if (rule.author) rule.author = identity(rule.author);
    for (const ref of [rule.scope, rule.ref].filter(Boolean)) {
      if (!this.canReadReference(ref, context) || !this.canReadReference(ref, targetContext)) reject('wakeup_forbidden', 'Wakeup reference is unavailable', 403);
    }
    if (current && (current.rule.kind !== rule.kind || rule.kind === 'room_base' && current.rule.room !== rule.room)) {
      reject('wakeup_conflict', 'Wakeup category and its base Room are fixed', 409);
    }
    const id = current?.id || (rule.kind === 'room_base' ? roomBaseId(botId, rule.room) : callId);
    const duplicate = !current && this.store.get(wakeupRecords, id);
    if (duplicate) assertRevision(duplicate.revision, args.revision);
    const at = rule.kind === 'time' ? Date.parse(rule.at) : null;
    if (at !== null && !Number.isFinite(at)) reject('invalid_wakeup', 'Specify a valid time for this Wakeup');
    const next_due = args.event_or_time ? at : current.next_due;
    if (rule.kind === 'time' && args.enabled && next_due === null) reject('wakeup_time_required', 'Set the next time for an expired Wakeup', 409);
    const saved = this.store.save(wakeupRecords, { id, bot_id: botId, rule, next_due,
      enabled: args.enabled ?? current?.enabled ?? true, revision: (current?.revision || 0) + 1, member_active: true });
    return { ...saved, kind: 'wakeup' };
  }

  matches(wakeup, event) {
    const { rule, bot_id } = wakeup;
    if (!wakeup.enabled || wakeup.member_active === false || rule.kind === 'time' || !this.ruleUsable(rule, bot_id)) return false;
    if (event.type === 'message' && event.author.id === bot_id && event.author.kind === 'bot') return false;
    if (rule.kind === 'room_base') {
      return event.type === 'message' && event.roomId === rule.room && (rule.mode === 'all' ||
        event.mentions?.includes(bot_id) || event.replyAuthorId === bot_id);
    }
    return rule.type === event.type && (!rule.room || event.roomId === rule.room || sameRef(event.space, { kind: 'room', id: rule.room })) &&
      (!rule.author || sameIdentity(event.author, rule.author)) && (!rule.ref || sameRef(event.ref || event.target, rule.ref));
  }

  queueMessage(message) {
    const author = message.senderId === 'user' ? { kind: 'user', id: 'user' }
      : message.senderId === 'system' ? { kind: 'platform', id: 'platform' } : { kind: 'bot', id: message.senderId };
    const event = { id: message.id, type: 'message', kind: 'event', roomId: message.roomId, space: { kind: 'room', id: message.roomId },
      author, time: message.createdAt, sequence: message.sequence, text: message.content, content: message.content,
      mentions: message.mentions, reply_to: message.replyTo, replyAuthorId: message.replyAuthorId, attachments: message.attachments,
      references: message.references, call_id: message.callId };
    this.queueEvent(event);
  }

  queueEvent(event, waits = [], matchWakeups = true, excludedBotId) {
    const byBot = new Map();
    const entry = id => {
      if (!byBot.has(id)) byBot.set(id, { matches: [], waits: [] });
      return byBot.get(id);
    };
    for (const wait of waits) entry(wait.bot_id).waits.push(wait);
    for (const wakeup of matchWakeups ? this.store.list(wakeupRecords) : []) {
      if (wakeup.bot_id === excludedBotId) continue;
      if (!this.matches(wakeup, event)) continue;
      try { if (!this.canReadEvent(wakeup.bot_id, event)) continue; }
      catch { /* Delivery will recheck access before the event reaches an inbox. */ }
      entry(wakeup.bot_id).matches.push({ id: wakeup.id, revision: wakeup.revision, kind: wakeup.rule.kind });
    }
    const existing = this.deliveriesFor(event.id);
    if (event.type !== 'message' && !this.store.get('platform-events', event.id)) this.store.save('platform-events', event);
    for (const [botId, links] of byBot) this.enqueue(botId, event, links.matches, links.waits, existing);
  }

  enqueue(botId, event, matches, waits, deliveries = this.deliveriesFor(event.id)) {
    const previous = deliveries.find(item => item.bot_id === botId && item.event.id === event.id);
    const match_sources = unique([...(previous?.match_sources || []), ...matches], item => keyOf(item.id, item.revision));
    const wait_refs = unique([...(previous?.wait_refs || []), ...waits], item => item.id);
    if (previous && match_sources.length === (previous.match_sources?.length || 0) && wait_refs.length === (previous.wait_refs?.length || 0)) return previous;
    return this.store.save(deliveryRecords, { id: previous?.id ?? keyOf('delivery', botId, event.id), bot_id: botId, event, match_sources, wait_refs,
      revision: (previous ? previous.revision ?? 1 : 0) + 1, status: 'pending', received_at: null, processed_at: null,
      sent_wait_access: null, retry_at: null });
  }

  tickTime() {
    this.store.transaction(() => {
      const now = Date.now();
      for (const wakeup of this.store.list(wakeupRecords)) {
        if (!wakeup.enabled || wakeup.rule.kind !== 'time' || wakeup.next_due == null || wakeup.next_due > now) continue;
        const { bot_id, rule } = wakeup;
        if (rule.scope && !this.canReadReference(rule.scope, { actor: { kind: 'bot', id: bot_id },
          workspaceProfileId: this.manager.get(bot_id).workspaceProfileId ?? null })) continue;
        const platform = { kind: 'platform', id: 'platform' };
        const event = this.store.save('platform-events', { id: keyOf('time', wakeup.id, wakeup.next_due), kind: 'event', type: 'wakeup.time',
          author: platform, bot_id, space: rule.scope?.kind === 'room' || rule.scope?.kind === 'bot' ? rule.scope : { kind: 'bot', id: bot_id },
          ref: rule.scope || null, time: new Date(wakeup.next_due).toISOString() });
        this.enqueue(bot_id, event, [{ id: wakeup.id, revision: wakeup.revision, kind: 'time' }], []);
        const next_due = rule.interval_ms ? wakeup.next_due + (Math.floor((now - wakeup.next_due) / rule.interval_ms) + 1) * rule.interval_ms : null;
        this.store.save(wakeupRecords, { id: wakeup.id, next_due, last_event_id: event.id });
      }
    });
  }

  messageDeliveries(id) {
    return this.deliveriesFor(id).map(({ id, bot_id, status, match_sources, received_at }) =>
      ({ id, bot_id, status, match_sources, received_at }));
  }

  consume(botId, id, receipt) {
    this.store.transaction(() => {
      const item = this.store.get(deliveryRecords, id);
      if (!item || item.bot_id !== botId || item.status !== 'received' || !receipt || receipt.accepted === false ||
          (receipt.revision ?? 1) !== (item.revision ?? 1)) return;
      const processed_at = new Date().toISOString();
      const included = new Map((item.wait_refs || []).map(wait => [wait.id, wait]));
      const outcomes = new Map(Object.entries(item.wait_receipts ?? {}));
      let changed = false;
      for (const wait of receipt.waits || []) {
        const link = included.get(wait.id);
        const prior = outcomes.get(wait.id);
        if (!link || !handledWaitStates.has(wait.state) || handledWaitStates.has(prior?.state)) continue;
        const live = this.store.get(waitRecords, wait.id);
        const latest = live?.latest_event_id === item.event.id;
        const accessRevoked = wait.state === 'access_revoked' || wait.result_access === 'revoked' ||
          (link.input_call_id && !this.canReadWait(link, item.event));
        const availability = accessRevoked ? 'revoked' : prior?.availability ?? (latest ? live.availability : undefined);
        outcomes.set(wait.id, { state: wait.state, availability, processed_at });
        changed = true;
        if (latest) {
          this.store.save(waitRecords, { id: wait.id, status: wait.state, availability, processed_at,
            ...(wait.state === 'processed' ? { result_position: item.event.result_position ?? item.event.id } : {}) });
        }
      }
      if (changed || receipt.processed === true) {
        this.store.save(deliveryRecords, { id, wait_receipts: Object.fromEntries(outcomes),
          ...(receipt.processed === true ? { status: 'processed', processed_at } : {}) });
        this.emit('delivery');
      }
    });
  }

  async flush(runtime) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = Date.now();
      const deliveries = [...this.returningRecords.all(now), ...this.pendingRecords.all(now, this.resources.limits.queue)];
      for (const row of deliveries) {
        const delivery = JSON.parse(row.data);
        const { id, bot_id, event, wait_refs = [], revision = 1, match_sources = [] } = delivery;
        let readable, waitAccess;
        try {
          readable = this.canReadEvent(bot_id, event);
          waitAccess = new Map(wait_refs.map(wait => [wait.id, readable && (!wait.input_call_id || this.canReadWait(wait, event))]));
        } catch {
          this.updateDelivery(id, revision, { retry_at: Date.now() + 1000 });
          continue;
        }
        const read = readable && (!wait_refs.length || match_sources.length > 0 || [...waitAccess.values()].some(Boolean));
        let prior;
        try { prior = delivery.status === 'unknown' ? await runtime.inboxReceipt(bot_id, id) : null; }
        catch {
          this.updateDelivery(id, revision, { retry_at: Date.now() + 1000 });
          continue;
        }
        if (prior?.accepted && (prior.revision ?? 1) >= revision) {
          const acceptedAccess = new Map([...waitAccess].map(([waitId, allowed]) =>
            [waitId, allowed && delivery.sent_wait_access?.[waitId] !== false]));
          this.markReceived(delivery, acceptedAccess, prior);
          continue;
        }
        if (!read && !wait_refs.length) {
          this.updateDelivery(id, revision, { status: 'access_revoked' });
          continue;
        }
        const body = read ? event : { id: event.id, kind: 'event', type: event.type, call_id: event.call_id, status: event.status,
          result_position: event.result_position, result_access: 'revoked', time: event.time, author: event.author };
        if (!this.updateDelivery(id, revision, { status: 'unknown', sent_wait_access: Object.fromEntries(waitAccess) })) continue;
        let result;
        try { result = await runtime.receive({ id, bot_id, event: body, match_sources, wait_refs, revision }); }
        catch (error) {
          if ([400, 403, 404, 409].includes(error.status)) {
            this.updateDelivery(id, revision, { status: 'rejected', code: error.code || 'delivery_rejected' });
          } else this.updateDelivery(id, revision, { retry_at: Date.now() + 1000 });
          continue;
        }
        if (result?.accepted) this.markReceived(delivery, waitAccess, result);
        else if (result?.retryable !== false) this.updateDelivery(id, revision, { status: 'pending', retry_at: Date.now() + 1000 });
        else this.updateDelivery(id, revision, { status: 'rejected', code: result.code || 'delivery_rejected' });
      }
    } finally { this.flushing = false; }
  }

  updateDelivery(id, revision, value) {
    const current = this.store.get(deliveryRecords, id);
    if (current && (current.revision ?? 1) === revision) return this.store.save(deliveryRecords, { id, ...value });
  }

  markReceived(delivery, waitAccess, receipt) {
    this.store.transaction(() => {
      const record = this.updateDelivery(delivery.id, delivery.revision ?? 1, { status: 'received', received_at: new Date().toISOString(),
        sent_wait_access: null, retry_at: null });
      if (!record) return;
      const outcomes = new Map(Object.entries(record.wait_receipts ?? {}));
      for (const wait of record.wait_refs || []) {
        const current = this.store.get(waitRecords, wait.id);
        if (handledWaitStates.has(outcomes.get(wait.id)?.state)) continue;
        const availability = waitAccess.get(wait.id) && receipt?.result_access !== 'revoked' ? 'available' : 'revoked';
        outcomes.set(wait.id, { state: 'received', availability });
        if (current?.latest_event_id === record.event.id && ['pending_delivery', 'received'].includes(current.status)) {
          this.store.save(waitRecords, { id: wait.id, status: 'received', availability });
        }
      }
      if (outcomes.size) this.store.save(deliveryRecords, { id: record.id, wait_receipts: Object.fromEntries(outcomes) });
      this.emit('delivery', { id: record.id, event_id: record.event.id, bot_id: record.bot_id, status: record.status });
      this.consume(record.bot_id, record.id, receipt);
    });
  }
}
