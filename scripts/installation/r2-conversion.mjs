import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { BotStore } from '../../bot/src/storage/store.mjs';
import { Inbox } from '../../bot/src/storage/inbox.mjs';
import { runtimeRecords as R, recordKey } from '../../bot/src/storage/runtime-records.mjs';
import { RecordStore } from '../../capabilities/shared/store.mjs';
import { activeControl, botRecords } from '../../capabilities/bot-management/service.mjs';
import { callRecords, waitRecords } from '../../capabilities/platform/calls.mjs';
import { connectionRecords, convertConnectionEntry, importNativeOperation, importNativeInput, importNetworkOperation,
  readLegacyOperationFacts, readLegacyInputFacts } from '../../capabilities/services/connection-records.mjs';
import { deliveryRecords, wakeupRecords } from '../../capabilities/platform/delivery.mjs';
import { sessionRecords, conversationRecords } from '../../capabilities/platform/executions.mjs';
import { files, fileRevisions } from '../../capabilities/filesystem/files.mjs';
import { within, readJson } from '../build/files.mjs';
import { hostLimitsRecord } from '../../capabilities/platform/resources.mjs';
import { removeInside } from '../release/repository.mjs';

const botRef = id => ({ kind: 'bot', id });
const conversationRef = id => ({ kind: 'conversation', id });
const roomRef = id => ({ kind: 'room', id });
const eventRef = id => ({ kind: 'event', id });
const fileRef = id => ({ kind: 'file', id });
const user = { kind: 'user', id: 'user' };
const system = { kind: 'platform', id: 'platform' };
const actor = id => !id || id === 'user' ? user : ['system', 'controller', 'platform'].includes(id) ? system : botRef(id);
const unique = values => [...new Set(values.filter(Boolean))];
const databasePath = (root, folder) => join(root, folder, 'state.sqlite');
const formerBotTables = ['messages', 'tasks', 'sessions', 'tools', 'events', 'outbox', 'memories', 'artifacts', 'state'];
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id);
const samePath = (left, right) => left && right && relative(left, right) === '';
const pausedWork = value => ['paused', 'cancelled'].includes(value?.status);
const finishedTask = value => ['completed', 'cancelled', 'failed'].includes(value?.status);
const removedGovernance = value => Boolean(value && (value.routeOnly || value.dutyRoute || value.teamStaffing || value.teamReview ||
  value.teamIntroduction || value.workflowReview || value.roomDutyAction || value.productionRecovery ||
  ['team-staffing', 'room-duty-action', 'workflow-review'].includes(value.sourceType)));

async function readOptional(path, read = readJson) {
  try { return await read(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readRows(path, select) {
  if (!await readOptional(path, stat)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try { return select(db); } finally { db.close(); }
}
const rows = (db, kind) => db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.data));
const allRows = db => db.prepare('SELECT kind,data FROM records ORDER BY rowid').all().map(row => ({ kind: row.kind, value: JSON.parse(row.data) }));
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const table = (db, name) => hasTable(db, name) ? db.prepare(`SELECT rowid AS sequence,${name === 'state' ? 'scope,key,' : ''}data FROM ${name} ORDER BY rowid`).all()
  .map(row => {
    const value = JSON.parse(row.data);
    if (name === 'state') return { scope: row.scope, key: row.key, value };
    return name === 'events' ? { seq: row.sequence, ...value } : value;
  }) : [];

function putFile(store, record) {
  const saved = store.import(files, record);
  store.import(fileRevisions, { ...saved, id: recordKey(saved.id, saved.revision), file_id: saved.id });
}
function notes(store, id, space, path, value, sources = [], original = {}) {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  putFile(store, { id, space, path, revision: 1, author: system, sources, content, size: Buffer.byteLength(content),
    createdAt: original.createdAt, updatedAt: original.updatedAt });
}
function history(store, namespace, kind, value, space = user) {
  if (!value?.id) return;
  // The ordinary history stores the original identity without re-enabling the old schedulers or policy.
  store.import('migration-history', { id: recordKey(namespace, kind, value.id), space, original_kind: kind,
    original_id: value.id, value, createdAt: value.createdAt, updatedAt: value.updatedAt });
}

function historyEnvelope(botId, table, row, index) {
  const originalId = row.id ?? (table === 'state' ? recordKey(row.scope, row.key) : row.seq ?? index + 1);
  const kind = ['messages', 'tasks', 'sessions', 'tools', 'events', 'outbox'].includes(table) ? 'migration-conversation-history' : 'migration-history';
  return { kind, value: { id: recordKey('table', table, originalId), original_kind: table, original_id: originalId, bot_id: botId, value: row } };
}

function controlOf(work) {
  if (!work) return activeControl();
  const stopped = work.externalStop;
  const control_version = Number.isSafeInteger(work.controlRevision) ? work.controlRevision : 1;
  if (!pausedWork(work)) return { ...activeControl(), control_version };
  const stop_status = stopped?.status === 'pending' ? 'pending' : ['unknown', 'failed'].includes(stopped?.status) ? stopped.status : 'stopped';
  return { ...activeControl(), state: 'paused', control_version, stop_id: stopped?.id || recordKey('legacy-stop', work.id, control_version),
    requested_by: user, stop_status, stop_requested_at: stopped?.requestedAt, native_stop: stopped };
}

async function modelBindings(dataRoot, bots, workspaces, journal) {
  const configRoot = join(dataRoot, 'config');
  const target = join(configRoot, 'model-connections.json'), secretTarget = join(configRoot, 'model-credentials.json');
  const catalog = await readOptional(target) || { schemaVersion: 1, activeId: null, connections: [] };
  catalog.activeByProfile ||= {};
  const credentials = await readOptional(secretTarget) || {};
  const usageTarget = join(configRoot, 'model-usage.json');
  const usage = await readOptional(usageTarget) || {};
  const profiles = new Map();
  const paths = unique([
    ...bots.map(bot => typeof bot.config?.model?.connectionStore === 'string' ? resolve(bot.config.model.connectionStore) : null),
    ...workspaces.filter(profile => safeId(profile.id)).map(profile => join(configRoot, 'workspaces', profile.id, 'model-connections.json')),
  ]);
  for (const path of paths) {
    if (samePath(path, target)) continue;
    if (!within(configRoot, path) || basename(path) !== 'model-connections.json') throw new Error('A registered model catalog is outside the installation configuration directory');
    const source = await readOptional(path);
    if (!source) { profiles.set(path, { connectionIds: new Map(), source }); continue; }
    const id = basename(dirname(path));
    if (!safeId(id)) throw new Error('Invalid scoped model catalog identity');
    const savedCredentials = await readOptional(join(dirname(path), 'model-credentials.json')) || {};
    const priorUsage = await readOptional(join(dirname(path), 'model-usage.json')) || {};
    const connectionIds = new Map();
    for (const entry of source.connections) {
      const targetId = `${id}--${entry.id}`;
      connectionIds.set(entry.id, targetId);
      if (!catalog.connections.some(item => item.id === targetId)) {
        catalog.connections.push({ ...entry, id: targetId, workspaceProfileId: id, ...(entry.environmentFile || source.environmentFile ?
          { environmentFile: entry.environmentFile || source.environmentFile } : {}) });
      }
      if (savedCredentials[entry.id] && !Object.hasOwn(credentials, targetId)) credentials[targetId] = savedCredentials[entry.id];
      if (priorUsage[entry.id] && !Object.hasOwn(usage, targetId)) usage[targetId] = priorUsage[entry.id];
    }
    catalog.activeByProfile[id] = connectionIds.get(source.activeId) || null;
    profiles.set(path, { connectionIds, source });
  }
  if (profiles.size) {
    await journal.json('model-credentials', secretTarget, credentials);
    await journal.json('model-catalog', target, catalog);
    await journal.json('model-usage', usageTarget, usage);
  }
  return {
    replacedPaths: [...profiles].filter(([, profile]) => profile.source).flatMap(([path]) =>
      [path, join(dirname(path), 'model-credentials.json'), join(dirname(path), 'model-usage.json')]),
    modelFor(bot) {
      const path = typeof bot.config?.model?.connectionStore === 'string' ? resolve(bot.config.model.connectionStore) : null;
      const profile = path ? profiles.get(path) : profiles.get(join(configRoot, 'workspaces', bot.workspaceProfileId || '', 'model-connections.json'));
      const source = profile ? profile.source : catalog;
      const activeId = source?.activeId;
      const current = source?.connections.find(item => item.id === activeId);
      const connection_id = profile ? profile.connectionIds.get(activeId) : activeId;
      return { model: current && connection_id ? { connection_id, id: current.model, thinking_level: current.thinkingLevel || 'high' } : null,
        model_ids: profile ? [...profile.connectionIds.values()] : catalog.connections.filter(item => !item.workspaceProfileId).map(item => item.id) };
    },
  };
}

async function readBot(dataRoot, previousRelease, row) {
  if (!safeId(row.id)) throw new Error('Invalid retained Bot directory identity');
  const dir = join(dataRoot, 'bots', row.id);
  const config = await readOptional(join(dir, 'config.json'));
  const role = safeId(row.roleId) ? row.roleId : 'default';
  const template = previousRelease && await readOptional(join(previousRelease, 'roles', role, 'prompt.md'), path => readFile(path, 'utf8'));
  const declared = typeof row.prompt === 'string' ? row.prompt : '';
  const generated = template === null ? [] : [template, [template, declared ? '\n用户设定的身份与职责：\n' + declared : ''].filter(Boolean).join('\n'),
    [template, declared].filter(Boolean).join('\n\n')];
  const effective = typeof config?.prompt === 'string' ? config.prompt : null;
  // Catalog/provisioned prompts have a known generated source. Retain exact
  // source text as private reference material; only a separately saved user prompt is active.
  const instructions = row.maintenanceFor ? '' : declared;
  const legacyPrompt = effective && effective !== instructions && !generated.includes(effective) ? effective :
    row.maintenanceFor && declared ? declared : null;
  return { ...row, config, dir, instructions, legacyPrompt };
}

function convertRooms(store, rooms, bots) {
  for (const room of rooms) {
    const space = roomRef(room.id);
    if (room.goal || room.summary || room.team) notes(store, recordKey('room-notes', room.id), space,
      'history/room-notes.json', { goal: room.goal, summary: room.summary, team: room.team, original_state: room.status }, [], room);
    const members = unique(room.members || []);
    store.import('rooms', { id: room.id, name: room.name, members, pins: room.pins || [], revision: room.revision || 1,
      workspaceProfileId: room.workspaceProfileId ?? null, createdAt: room.createdAt, updatedAt: room.updatedAt });
    for (const id of members) {
      if (!bots.has(id)) continue;
      const old = room.memberSettings?.[id]?.watch;
      store.import(wakeupRecords, { id: recordKey('room_base', id, room.id), bot_id: id,
        rule: { kind: 'room_base', room: room.id, mode: old === 'mentions' ? 'mentions' : 'all' },
        enabled: old !== false && old !== 'off', member_active: true, revision: 1 });
    }
  }
}

function normalizeReferences(values) {
  return (Array.isArray(values) ? values : []).flatMap(ref => {
    if (ref?.kind && ref.id) return [ref];
    if (ref?.type === 'room' && ref.messageId) return [eventRef(ref.messageId)];
    if (ref?.type === 'file' && ref.id) return [fileRef(ref.id)];
    return [];
  });
}

function convertMessages(store) {
  const selected = store.db.prepare("SELECT rowid AS sequence,data FROM records WHERE kind='messages' ORDER BY rowid").all();
  const original = new Map(selected.map(({ sequence, data }) => {
    const row = JSON.parse(data);
    return [row.id, { ...row, sequence }];
  }));
  for (const row of original.values()) {
    const parent = original.get(row.replyTo);
    const replyTo = parent?.roomId === row.roomId ? row.replyTo : undefined;
    const mentions = unique([...(row.mentions || []), row.toBotId]);
    const refs = normalizeReferences(row.references || row.sourceRefs);
    const source = actor(row.senderId);
    store.import('messages', { id: row.id, roomId: row.roomId, senderId: row.senderId, source, author: source, kind: 'message',
      content: row.content, attachments: row.attachments || [], references: refs, mentions, clientId: row.clientId, replyTo,
      installation_migration_id: row.installation_migration_id,
      replyAuthorId: replyTo ? parent.senderId : undefined, callId: row.callId, createdAt: row.createdAt, updatedAt: row.updatedAt });
    history(store, 'chatroom', 'message-origin', row, roomRef(row.roomId));
  }
}

function messageEvent(store, id) {
  const raw = store.db.prepare("SELECT rowid AS sequence,data FROM records WHERE kind='messages' AND id=?").get(id);
  if (!raw) return null;
  const row = JSON.parse(raw.data);
  return { id, kind: 'event', type: 'message', roomId: row.roomId, space: roomRef(row.roomId), author: row.author || actor(row.senderId),
    sequence: raw.sequence, time: row.createdAt, text: row.content, content: row.content, reply_to: row.replyTo,
    replyAuthorId: row.replyAuthorId, mentions: row.mentions, references: row.references, attachments: row.attachments };
}

function taskInput(store, botId, task, row, delivery) {
  const trigger = task.metadata?.originMessageId || task.input?.trigger?.id || delivery?.messageId;
  const saved = trigger && messageEvent(store, trigger);
  if (saved) return saved;
  const id = row?.sourceMessageId || task.messageId;
  if (!id) return null;
  const content = row?.content ?? task.input;
  const source = actor(row?.metadata?.actor || task.metadata?.actor || row?.from || task.source);
  return { id, kind: 'event', type: 'message', author: source, space: botRef(botId),
    time: row?.receivedAt || task.createdAt, content, text: typeof content === 'string' ? content : undefined };
}

function runRef(botId, task) {
  return { bot_id: botId, conversation_id: recordKey(botId, task.conversationId || task.sessionId || task.id), run_id: task.runId || task.id };
}

async function readBotDatabase(bot, select) { return readRows(join(bot.dir, 'state.sqlite'), select); }

function retainPausedInputs(db, botId, works, owners) {
  for (const input of db.listRecords('work-events')) {
    const work = works.get(input.workId);
    if (!pausedWork(work) || input.kind !== 'request' || input.status !== 'pending' || input.receipt) continue;
    const conversation = owners.get(recordKey(botId, work.conversationId || work.id));
    if (!conversation) continue;
    const openedBy = input.authorization?.source;
    const originalSource = openedBy?.replyTo || openedBy?.messageId;
    const originalAuthor = openedBy?.actor || openedBy?.source;
    const event = { id: input.id, kind: 'event', type: 'input.recorded', ref: conversationRef(conversation.id),
      space: conversation.space, bot_id: conversation.bot_id, author: originalAuthor ? actor(originalAuthor) : system,
      status: 'not_submitted', original_status: input.status, content: input.content, time: input.createdAt,
      source_event_ids: originalSource ? [originalSource] : [], control_version: input.controlRevision ?? conversation.control.control_version };
    db.putRecord(R.event, { id: event.id, event });
    db.putRecord(R.input, { id: input.id, event_id: event.id, conversation_id: conversation.id,
      kind: 'next', status: event.status, control_version: event.control_version, submitted_by: event.author });
  }
}

async function convertBotRuns({ store, bot, deliveries, journal }) {
  const path = join(bot.dir, 'state.sqlite');
  if (!await readOptional(path, stat)) return null;
  const db = new BotStore(path);
  const inbox = new Inbox(db, bot.id);
  const originals = db.list('tasks');
  try {
    await journal.step(db, `bot:${bot.id}`, () => {
      const sourceMessages = new Map(db.listMessages().map(message => [message.id, message]));
      const taskById = new Map(originals.map(task => [task.id, task]));
      const sessions = new Map(db.list('sessions').map(row => [row.id, row]));
      const toolRuns = new Map();
      for (const tool of db.listTools()) {
        if (!toolRuns.has(tool.taskId)) toolRuns.set(tool.taskId, []);
        toolRuns.get(tool.taskId).push(tool);
      }
      const works = new Map(db.listRecords('works').map(work => [work.id, work]));
      const owners = new Map();
      const ensureConversation = (original, work, space) => {
        const id = recordKey(bot.id, original);
        if (owners.has(id)) return owners.get(id);
        const record = { id, original_id: original, bot_id: bot.id, kind: work ? 'legacy-conversation' : 'room',
          space: space || botRef(bot.id), owner: botRef(bot.id), control: controlOf(work), input_revision: 0 };
        inbox.putConversation(record);
        owners.set(id, record);
        return record;
      };
      for (const work of works.values()) ensureConversation(work.conversationId || work.id, work, botRef(bot.id));
      for (const task of originals) {
        const row = sourceMessages.get(task.messageId);
        const delivery = deliveries.find(item => item.taskId === task.id || item.id === row?.sourceMessageId);
        const event = taskInput(store, bot.id, task, row, delivery);
        const governed = removedGovernance(task.metadata) || removedGovernance(delivery);
        const work = works.get(task.workId);
        const identity = runRef(bot.id, task);
        const conversation = ensureConversation(task.conversationId || task.sessionId || task.id, work, event?.space);
        const originalRoute = event && !governed && row;
        const receivedAt = row?.receivedAt || task.createdAt;
        const actualDeliveryId = delivery?.id || row?.sourceMessageId;
        if (originalRoute && actualDeliveryId) {
          const route = { id: recordKey(event.id, 'observation'), event_id: event.id, conversation_id: conversation.id, run_id: identity.run_id,
            state: finishedTask(task) ? 'processed' : 'pending', match_sources: [] };
          db.putRecord(R.event, { id: event.id, event, received_at: receivedAt });
          db.putRecord(R.delivery, { id: actualDeliveryId, event_id: event.id, bot_id: bot.id, state: 'received', revision: 1,
            received_at: receivedAt, match_sources: [], wait_refs: [] });
          const prior = db.getRecord(R.route, route.id);
          if (!prior || prior.state === 'processed' && route.state === 'pending') db.putRecord(R.route, route);
        }
        const tools = toolRuns.get(task.id) || [];
        const hasUnknown = tools.some(tool => !['completed', 'failed'].includes(tool.status));
        const issued = Boolean(task.startedAt || tools.length);
        const blocked = work?.status === 'blocked' && !task.metadata?.nativeEngineReview;
        const state = governed || !originalRoute ? 'archived' : finishedTask(task) ? task.status :
          blocked ? 'suspended' : hasUnknown || issued ? 'interrupted' : 'pending';
        const received = originalRoute ? [event.id] : [];
        const routeId = originalRoute && db.getRecord(R.route, recordKey(event.id, 'observation'))?.run_id === identity.run_id ?
          [recordKey(event.id, 'observation')] : [];
        inbox.putRun({ id: identity.run_id, conversation_id: conversation.id, original_task_id: task.id, state,
          control_version: conversation.control.control_version, pending_event_ids: received, injected_event_ids: issued ? received : [],
          processed_event_ids: task.status === 'completed' ? received : [], route_ids: routeId,
          created_at: task.createdAt, submitted_by: event?.author || botRef(bot.id), original_state: task.status,
          ...(blocked ? { original_work_state: work.status } : {}) });
        if (issued || task.result) {
          const text = JSON.stringify({ original_task_id: task.id, status: task.status, result: task.result,
            calls: tools.map(({ id, name, status }) => ({ id, name, status })) });
          const old = sessions.get(task.sessionId);
          const started = Date.parse(task.startedAt || task.createdAt), finished = Date.parse(task.finishedAt || task.updatedAt);
          const candidates = old?.messages?.filter(row => row.timestamp >= started && row.timestamp <= finished &&
            ['assistant', 'toolResult'].includes(row.role)) || [];
          db.putRecord(R.transcript, { id: identity.run_id,
            messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(task.updatedAt) || Date.parse(receivedAt) || Date.now() }],
            original_session_id: task.sessionId, original_task_id: task.id, original_messages: candidates });
          if (old?.checkpoints?.length || old?.contextEdits?.length) {
            db.putRecord('migration-history', { id: recordKey('context', task.sessionId), original_kind: 'context',
              original_id: task.sessionId, value: { checkpoints: old.checkpoints, edits: old.contextEdits } });
          }
        }
        for (const call of tools) db.putRecord(R.call, { id: call.id, run_id: identity.run_id, conversation_id: conversation.id,
          model_call_id: call.toolCallId, tool: call.name, state: ['completed', 'failed'].includes(call.status) ? call.status : 'unknown',
          result: call.output, original_receipt: call });
      }
      for (const wait of db.listRecords('work-waits')) {
        const origin = taskById.get(wait.sourceTaskId) || taskById.get(wait.taskId);
        if (!origin) continue;
        const identity = runRef(bot.id, origin);
        const call_id = wait.dependencyEventId || wait.taskId;
        if (!call_id) continue;
        db.putRecord(R.wait, { id: wait.id, ...identity, call_id, status: wait.status === 'pending' ? 'waiting' : wait.status,
          control_version: controlOf(works.get(wait.targetWorkId || wait.workId)).control_version, result_position: wait.observationId,
          event_ids: [], retained_wait: wait });
      }
      retainPausedInputs(db, bot.id, works, owners);
      for (const work of works.values()) db.putRecord('legacy-work-history', work);
    });
    const sourceMessages = db.listMessages();
    const inputs = db.listRecords(R.event).filter(row => row.event.type === 'input.recorded').map(row => row.event);
    return { conversations: db.listRecords(R.conversation), waits: db.listRecords(R.wait), works: db.listRecords('legacy-work-history'),
      originalTasks: originals, receipts: new Map(db.listRecords(R.delivery).map(receipt => [receipt.id, receipt])), calls: db.listRecords(R.call),
      explicitNotifications: db.listRecords('work-notifications').filter(row => row.publication === 'explicit'),
      outbox: new Map(db.list('outbox').map(row => [row.id, row])), inputs,
      peerReceipts: new Map(sourceMessages.map(row => [recordKey(row.from, row.sourceMessageId), row])) };
  } finally { db.close(); }
}

async function materialFile(path, boundaries) {
  let physical;
  try { physical = await realpath(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!boundaries.some(root => within(root, physical))) return null;
  const info = await stat(physical);
  if (!info.isFile()) return null;
  return { physical, size: info.size };
}

async function botMaterials(bot, { dataRoot, appRoot, journal, works }) {
  const space = botRef(bot.id);
  const storePath = join(bot.dir, 'state.sqlite');
  if (!await readOptional(storePath, stat)) return { files: [], selections: [], consumed: [] };
  const { scope, references, memories, pending, artifacts } = await readBotDatabase(bot, db => ({
    scope: rows(db, 'knowledge_scope'), references: rows(db, 'knowledge_reference'),
    pending: rows(db, 'knowledge-write'), memories: table(db, 'memories'), artifacts: table(db, 'artifacts'),
  }));
  const releaseRoot = await realpath(join(appRoot, 'releases'));
  const options = [await realpath(dataRoot), releaseRoot];
  const prepared = new Map(pending.map(item => [item.id, item]));
  const target = new Map();
  const entries = [];
  const add = (id, path, content, revision = 1, sources = [], dates = {}, author = space) => {
    const row = { id, space, path, content, revision: Math.max(1, revision || 1), sources, author,
      size: Buffer.byteLength(content), createdAt: dates.createdAt, updatedAt: dates.updatedAt };
    entries.push(row);
    return row;
  };
  for (const work of works) {
    const id = recordKey(bot.id, 'work-history', work.id);
    const { goal, requirements, progress, checkpoint, project, lastError } = work;
    add(id, `history/work/${encodeURIComponent(work.id)}.json`, JSON.stringify({
      id: work.id, goal, requirements, progress, checkpoint, project, lastError,
    }, null, 2), 1,
      (work.sources || []).filter(source => source.replyTo).map(source => eventRef(source.replyTo)), work, system);
  }
  for (const item of scope) {
    if (!item.file) continue;
    const file = await materialFile(join(bot.dir, 'knowledge', item.file), options);
    if (file) {
      const revision = item.revision || 1;
      const record = add(recordKey(bot.id, 'knowledge', item.id), `memory/${encodeURIComponent(item.id)}.md`,
        await readFile(file.physical, 'utf8'), revision, normalizeReferences(item.scopeRefs), item);
      target.set(item.id, record);
    }
    const intent = prepared.get(item.id);
    if (!intent?.preparedFile) continue;
    const source = await materialFile(join(bot.dir, 'knowledge', intent.preparedFile), options);
    if (source) add(recordKey(bot.id, 'knowledge-writing', item.id), `history/pending-knowledge/${encodeURIComponent(item.id)}.md`,
      await readFile(source.physical, 'utf8'), 1, target.get(item.id) ? [fileRef(target.get(item.id).id)] : [], item);
  }
  for (const memory of memories) {
    if (typeof memory.text === 'string') add(recordKey(bot.id, 'memory', memory.id), `memory/notes/${encodeURIComponent(memory.id)}.md`,
      memory.text, memory.revision, normalizeReferences(memory.sourceRefs), memory);
  }
  const artifactRoot = join(bot.dir, 'artifacts');
  for (const artifact of artifacts.filter(row => typeof row.path === 'string' && isAbsolute(row.path))) {
    const found = await materialFile(artifact.path, [artifactRoot]);
    if (!found) continue;
    const id = recordKey(bot.id, 'artifact', artifact.id);
    const name = basename(artifact.name || found.physical);
    const directory = join(dataRoot, 'capabilities', 'chatroom', 'attachments');
    const actionId = recordKey('artifact-bytes', bot.id, artifact.id);
    const target = journal.fileTarget(actionId) || join(directory, randomUUID(), 'data');
    await journal.preserve(actionId, found.physical, target);
    const attachment_id = basename(dirname(target));
    const metadata = { id: attachment_id, name, size: found.size, ownerId: bot.id,
      workspaceProfileId: bot.workspaceProfileId ?? null, mimeType: artifact.mimeType || 'application/octet-stream',
      createdAt: artifact.createdAt, url: `/api/attachments/${attachment_id}`, ref: fileRef(attachment_id), revision: 1 };
    await journal.json(recordKey('artifact-meta', bot.id, artifact.id), join(dirname(target), 'metadata.json'), metadata);
    entries.push({ id, space, path: `artifacts/${encodeURIComponent(artifact.id)}/${name}`, revision: 1,
      author: space, sources: normalizeReferences(artifact.sources), content: null, size: found.size, attachment_id, createdAt: artifact.createdAt });
  }
  if (bot.legacyPrompt) add(recordKey(bot.id, 'legacy-prompt'), 'history/previous-instructions.md', bot.legacyPrompt, 1, [], bot, system);
  const configured = [...(bot.config?.skills || []), ...(bot.config?.promptPaths || []), bot.config?.promptFile].filter(path => typeof path === 'string');
  const candidates = new Set();
  for (const folder of [join(bot.dir, 'skills'), ...configured]) {
    const source = await readOptional(folder, stat);
    if (!source) continue;
    if (source.isFile()) candidates.add(folder);
    if (source.isDirectory()) {
      const direct = join(folder, 'SKILL.md');
      if (await readOptional(direct, stat)) candidates.add(direct);
      for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) {
        const skill = join(folder, entry.name, 'SKILL.md');
        if (await readOptional(skill, stat)) candidates.add(skill);
      }
    }
  }
  for (const path of candidates) {
    const bundled = within(releaseRoot, path) && (bot.config?.bundledSkills || []).some(name =>
      within(join(bot.config.bundleRoot || options[0], 'skills', name), path));
    if (bundled) continue;
    const id = recordKey(bot.id, 'registered-material', path);
    const preserved = journal.fileTarget(id);
    const source = await materialFile(preserved || path, options);
    if (!source) continue;
    if (!preserved && within(releaseRoot, source.physical)) {
      const destination = join(dataRoot, 'bots', bot.id, 'materials', 'pre-installation', randomUUID() + '-' + basename(path));
      await journal.preserve(id, source.physical, destination);
    }
    const body = await readFile(journal.fileTarget(id) || source.physical, 'utf8');
    add(id, `materials/${encodeURIComponent(path)}/${basename(path)}`, body);
  }
  const selections = [], consumed = [];
  for (const reference of references) {
    const file = target.get(reference.scopeId);
    const sourceRefs = normalizeReferences([reference.origin?.reference, ...(reference.references || [])].filter(Boolean));
    const applies_to = [space];
    const originalScope = scope.find(item => item.id === reference.scopeId);
    if (originalScope?.roomId) applies_to.push(roomRef(originalScope.roomId));
    if (originalScope?.conversationId) applies_to.push({ kind: 'conversation', id: recordKey(bot.id, originalScope.conversationId) });
    const item = { id: reference.id, revision: 1, note: reference.note || '', source_refs: sourceRefs,
      applies_to, selected: Boolean(file), ...(file ? { target_ref: fileRef(file.id) } : {}) };
    selections.push(item);
    if (reference.status === 'processed' && file) consumed.push({ reference, item, file });
  }
  return { files: entries, selections, consumed };
}

function originalCallId(row) {
  const resource = row.resourceId || row.entryId;
  return typeof row.operationId === 'string' && row.operationId ? row.operationId : recordKey(row.actor, row.workId, resource, row.id);
}

async function externalFacts(dataRoot, old) {
  const native = await Promise.all(old.filter(row => row.kind === 'native-executions').map(async ({ value: row }) =>
    ({ row, facts: await readLegacyOperationFacts(dataRoot, row) })));
  const map = new Map(native.map(value => [value.row.id, value]));
  const inputs = await Promise.all(old.filter(row => row.kind === 'native-execution-inputs').map(async ({ value: row }) => {
    const operation = map.get(row.operation);
    return { row, operation, facts: operation ? await readLegacyInputFacts(dataRoot, row, operation.row, operation.facts) : null };
  }));
  return { native, inputs, network: old.filter(row => row.kind === 'catalog-requests').map(row => row.value) };
}

function importExternal(store, { native, network, inputs }, registry, botState) {
  const host = registry.find(item => item.kind === 'native-hosts' && item.value.id === 'local')?.value?.hostId;
  for (const { kind, value } of registry) if (kind === 'catalog-entries') {
    const connection = convertConnectionEntry(value, host);
    if (connection) {
      const owner = value.ownerBotId || value.creatorBotId;
      const workspaceProfileId = owner ? store.get(botRecords, owner)?.workspaceProfileId ?? null : null;
      store.import(connectionRecords, { ...connection, workspaceProfileId,
        allowed_bot_ids: unique([...connection.allowed_bot_ids, value.ownerBotId, value.creatorBotId]) });
    }
  }
  const ids = new Map();
  for (const { row, facts, service } of [...native, ...network.map(row => ({ row, service: true, facts: {} }))]) {
    if (!row.actor || !row.operationId && !row.id) continue;
    if (!service && (!row.nonce || !row.resourceId)) continue;
    const callId = originalCallId(row);
    const prior = store.get(callRecords, callId);
    const id = prior ? recordKey('old-operation', row.actor, row.workId, callId, row.id) : callId;
    const origin = botState.get(row.actor)?.originalTasks.find(task => row.taskId ? task.id === row.taskId :
      task.workId === row.workId && task.metadata?.workEventId === row.executionEventId);
    const originRef = origin ? runRef(row.actor, origin) : null;
    const work = botState.get(row.actor)?.works.find(item => item.id === row.workId);
    const stopped = controlOf(work);
    const executionActor = row.actor === 'controller' ? user : botRef(row.actor);
    const connectionId = row.resourceId || row.entryId;
    const sessionId = row.engine && facts.thread_id ? recordKey(row.actor, connectionId, facts.thread_id) : id;
    const inputRevision = (store.get(sessionRecords, sessionId)?.input_revision || 0) + 1;
    const opts = { sessionId, callId: id, facts, inputRevision };
    const operation = service ? importNetworkOperation(store, row, opts) : importNativeOperation(store, row, opts);
    ids.set(row.id, id);
    const execution = { kind: 'session', id: sessionId };
    const status = operation.status;
    const native = { protocol: operation.protocol, instance_id: operation.instance_id, thread_id: operation.thread_id,
      turn_id: operation.turn_id, model: operation.binding?.model, effort: operation.binding?.effort };
    const outcome = { kind: 'call', id, status, target: execution, native,
      output: operation.result, error: operation.error };
    const waits = (botState.get(row.actor)?.waits || []).filter(wait => wait.call_id === row.operationId ||
      wait.retained_wait?.dependencyEventId === row.executionEventId && row.executionEventId);
    const returnable = ['completed', 'failed', 'stopped', 'unknown'].includes(status);
    const resultEventId = recordKey('call', id, operation.observed_at || operation.finished_at || status);
    const observedEvent = returnable ? store.import('platform-events', {
      id: resultEventId, kind: 'event', type: 'call.receipt', author: system, call_id: id, target: execution, status,
      result_position: operation.offset ?? resultEventId, time: operation.finished_at || operation.observed_at || row.createdAt,
    }) : null;
    const routes = [];
    for (const wait of waits) {
      const alreadyObserved = wait.status === 'delivered' || wait.status === 'processed';
      const status = observedEvent ? alreadyObserved ? 'processed' : 'pending_delivery' : wait.status;
      const ref = store.import(waitRecords, { ...wait, call_id: id, session_id: sessionId, status,
        ...(observedEvent ? { latest_event_id: resultEventId } : {}) });
      if (observedEvent && !alreadyObserved) routes.push(ref);
    }
    if (observedEvent && routes.length) {
      for (const botId of unique(routes.map(wait => wait.bot_id))) {
        const waitRefs = routes.filter(wait => wait.bot_id === botId);
        const deliveryId = recordKey('delivery', botId, resultEventId);
        store.import(deliveryRecords, { id: deliveryId, bot_id: botId, event: observedEvent, match_sources: [], wait_refs: waitRefs,
          revision: 1, status: 'pending' });
      }
    }
    store.import(callRecords, { id, tool: 'open_session', submitted_by: executionActor, execution_actor: executionActor,
      origin: originRef, origin_bot: row.actor, source_event_ids: [], controls: [], session_id: sessionId, target: execution,
      status, result: outcome, result_ref: observedEvent ? eventRef(observedEvent.id) : { kind: 'call', id },
      return_refs: waits.map(wait => wait.id), external: true, charge_account: 'host',
      createdAt: row.createdAt, updatedAt: row.updatedAt });
    const workspaceId = store.get('platform-access', row.actor)?.workspace_ids?.find(id =>
      samePath(store.get('platform-workspaces', id)?.path, row.cwd));
    const workspace = workspaceId && store.get('platform-workspaces', workspaceId);
    const workspace_ref = workspace ? { kind: 'workspace', id: workspace.id } : null;
    const workspaceProfileId = store.get(botRecords, row.actor)?.workspaceProfileId ?? null;
    store.import(sessionRecords, { id: sessionId, engine: connectionId, owner: executionActor, execution_actor: executionActor,
      bot_id: executionActor.kind === 'bot' ? executionActor.id : null, space: executionActor, submitted_by: executionActor,
      model: null, latest_call_id: id, open_call_id: store.get(sessionRecords, sessionId)?.open_call_id || id,
      native, input_revision: inputRevision, workspaceProfileId,
      workspace: workspace ? { path: workspace.path, root: workspace.path, write: workspace.write } : null, workspace_ref,
      input_targets: [], connection_binding_version: store.get(connectionRecords, connectionId)?.binding_version || 1,
      resource_refs: [...connectionId ? [{ kind: 'connection', id: connectionId }] : [], ...workspace_ref ? [workspace_ref] : []],
      status, control: stopped, origin_execution: originRef ? { kind: 'conversation', id: originRef.conversation_id } : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt });
  }
  for (const { row, operation, facts } of inputs) {
    const id = operation && ids.get(operation.row.id);
    if (id && row.inputId) {
      importNativeInput(store, row, { operationId: id, facts });
      const parent = store.get(callRecords, id);
      const submitted_by = row.source === 'user' ? user : parent.submitted_by;
      const status = facts?.status ?? 'unknown';
      store.import(callRecords, { id: row.inputId, tool: row.type === 'stop' ? 'stop_session' : 'send_input',
        submitted_by, execution_actor: parent.execution_actor, origin: parent.origin, origin_bot: parent.origin_bot,
        source_event_ids: [], controls: parent.controls, target: parent.target, session_id: parent.session_id, status,
        result: { ...facts?.receipt, original_operation_call_id: id }, result_ref: { kind: 'call', id: row.inputId },
        return_refs: [], external: true, charge_account: 'host', createdAt: row.createdAt, updatedAt: row.updatedAt });
    }
  }
}

function convertDeliveries(store, jobs, state, botState, observations = []) {
  const seen = new Set();
  const add = (job, event) => {
    if (!event || !botState.has(job.botId) || !store.get('rooms', event.roomId)?.members.includes(job.botId)) return;
    const bot = botState.get(job.botId);
    const receipt = bot?.receipts?.get(job.id);
    const original = receipt && bot.originalTasks.find(task => task.id === job.taskId ||
      task.runId === job.agentRunId || task.metadata?.deliveryId === job.id);
    const status = receipt ? finishedTask(original) ? 'processed' : 'received' :
      job.status === 'queued' && !job.input && !job.taskId ? 'pending' :
        ['queued', 'accepted', 'running', 'waiting', 'interrupted'].includes(job.status) ? 'unknown' : 'historical';
    seen.add(recordKey(job.botId, event.id));
    store.import(deliveryRecords, { id: job.id, bot_id: job.botId, event, revision: 1, status, original_status: job.status,
      received_at: receipt?.received_at, match_sources: [{ id: job.id, kind: 'legacy_delivery', revision: 1 }], wait_refs: [],
      createdAt: job.createdAt, updatedAt: job.updatedAt });
  };
  for (const job of jobs) {
    history(store, 'chatroom', 'delivery', job, roomRef(job.roomId));
    if (!removedGovernance(job)) add(job, messageEvent(store, job.messageId));
  }
  // The drain entry may accept a message without starting the legacy router.
  for (const row of observations) {
    if (row.senderId !== 'user' || row.installation_migration_id !== state.migration_id) continue;
    const event = messageEvent(store, row.id), room = store.get('rooms', row.roomId);
    for (const botId of room?.members || []) {
      const rule = store.get(wakeupRecords, recordKey('room_base', botId, room.id));
      if (!rule?.enabled || seen.has(recordKey(botId, row.id))) continue;
      if (rule.rule.mode === 'mentions' && !(event?.mentions.includes(botId) || event?.replyAuthorId === botId)) continue;
      add({ botId, id: recordKey('delivery', botId, row.id), status: 'queued' }, event);
    }
  }
}

function publicationIds(notification) {
  const text = String(notification.content || '');
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 15000);
    const newline = text.lastIndexOf('\n', end);
    if (end < text.length && newline > start + 7500) end = newline + 1;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(Boolean(text.slice(start, end).trim()));
    start = end;
  }
  for (let start = 0; start < (notification.attachments?.length || 0); start += 8) parts[start / 8] = true;
  return parts.filter(Boolean).map((_, index) => index === 0 ? notification.id : `${notification.id}:part:${index + 1}`);
}

function convertExplicitPublications(store, botState, messages) {
  const byClient = new Map(messages.filter(row => row.clientId).map(row => [recordKey(row.roomId, row.senderId, row.clientId), row]));
  for (const [botId, info] of botState) {
    for (const entry of info.explicitNotifications || []) {
      const author = botRef(botId);
      const task = info.originalTasks.find(row => row.id === entry.taskId);
      const work = info.works.find(row => row.id === entry.workId);
      const conversationId = task ? runRef(botId, task).conversation_id : work && recordKey(botId, work.conversationId || work.id);
      const source = entry.authorization?.source;
      const roomId = entry.roomId || source?.roomId;
      const peerId = !roomId && (entry.botId || source?.source);
      const room = roomId && store.get('rooms', roomId);
      const target = room ? roomRef(room.id) : peerId && store.get(botRecords, peerId) ? botRef(peerId) : conversationId ? conversationRef(conversationId) : author;
      const callId = entry.id, ids = roomId ? publicationIds(entry) : [];
      const posted = ids.map(id => byClient.get(recordKey(roomId, botId, id))).filter(Boolean);
      const accepted = peerId && botState.get(peerId)?.peerReceipts?.get(recordKey(botId, entry.id));
      const peerReceipt = peerId && info.outbox?.get(`${peerId}:${entry.id}`)?.receipt;
      const receipt = Array.isArray(entry.receipt) ? entry.receipt.length > 0 && entry.status === 'delivered' : Boolean(entry.receipt && entry.status === 'delivered');
      const completed = receipt || Boolean(accepted || peerReceipt) || Boolean(ids.length && posted.length === ids.length);
      const status = completed ? 'completed' : ['superseded', 'local-only'].includes(entry.status) ? 'not_submitted' :
        entry.status === 'pending' && entry.waiting === 'source' && posted.length === 0 ? 'pending' : 'unknown';
      const sources = unique([entry.replyTo || source?.replyTo, ...(entry.sourceRefs || []).map(ref => ref?.messageId)])
        .filter(id => store.get('messages', id)?.roomId === roomId);
      const result = { status, original_status: entry.status, content: entry.content, message_refs: posted.map(row => eventRef(row.id)),
        receipt: entry.receipt ?? peerReceipt, ...(accepted ? { peer_receipt: { id: accepted.id, received_at: accepted.receivedAt } } : {}) };
      if (store.get(callRecords, callId)) continue;
      store.import(callRecords, { id: callId, tool: 'send', submitted_by: author, execution_actor: author,
        workspaceProfileId: store.get(botRecords, botId)?.workspaceProfileId ?? null, origin_bot: botId,
        origin: conversationId ? { bot_id: botId, conversation_id: conversationId, run_id: task ? runRef(botId, task).run_id : undefined } : null,
        source_event_ids: sources, controls: [], target, status, result, result_ref: { kind: 'call', id: callId },
        return_refs: [], external: false, charge_account: 'host', createdAt: entry.createdAt, updatedAt: entry.updatedAt || entry.deliveredAt });
    }
  }
}

function convertPrivateCalls(store, bot, state) {
  const author = botRef(bot.id);
  for (const call of state.calls || []) {
    if (store.get(callRecords, call.id)) continue;
    const target = conversationRef(call.conversation_id);
    store.import(callRecords, { id: call.id, tool: call.tool, submitted_by: author, execution_actor: author,
      workspaceProfileId: bot.workspaceProfileId ?? null, origin_bot: bot.id,
      origin: { bot_id: bot.id, conversation_id: call.conversation_id, run_id: call.run_id }, source_event_ids: [], controls: [],
      status: call.state, target, result: { status: call.state, output: call.result }, result_ref: { kind: 'call', id: call.id },
      return_refs: [], charge_account: 'host', createdAt: call.original_receipt?.startedAt,
      updatedAt: call.original_receipt?.finishedAt || call.original_receipt?.updatedAt });
  }
}

function convertClientReceipts(store, messages) {
  const inputs = new Map();
  const deliveriesForEvent = store.db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.event.id')=?");
  for (const message of messages) {
    if (!message.clientId || message.senderId !== 'user') continue;
    const room = store.get('rooms', message.roomId);
    if (!room) continue;
    const key = recordKey('user', 'user', room.workspaceProfileId ?? null, message.clientId);
    inputs.set(key, inputs.has(key) ? null : { message, room });
  }
  for (const [id, input] of inputs) {
    if (!input) continue; // The legacy client ID was unique only within a Room.
    const { message, room } = input, saved = store.get('messages', message.id);
    if (!saved) continue;
    const callId = message.callId || recordKey('room-send', message.id);
    if (store.get(callRecords, callId)) continue;
    const event = messageEvent(store, message.id);
    const projected = { ...saved, ...event, ref: eventRef(saved.id), kind: 'message' };
    const deliveries = deliveriesForEvent.all(deliveryRecords, saved.id).map(({ data }) => {
      const { id, bot_id, status, match_sources, received_at } = JSON.parse(data);
      return { id, bot_id, status, match_sources, received_at };
    });
    store.import(callRecords, { id: callId, tool: 'send', submitted_by: user, execution_actor: user,
      workspaceProfileId: room.workspaceProfileId ?? null, origin: null, source_event_ids: [], client_id: message.clientId,
      target: roomRef(room.id), status: 'completed', controls: [], result: { message: projected, deliveries },
      result_ref: { kind: 'call', id: callId }, return_refs: [], charge_account: 'host', createdAt: saved.createdAt });
    store.import('platform-client-calls', { id, call_id: callId });
  }
}

function attachHistory(store, rowsByDomain) {
  for (const [domain, records] of rowsByDomain) for (const { kind, value } of records) {
    if (['capability-actors', 'capability-services', 'capability-versions', 'switches', 'service-restarts',
      'native-hosts', 'chatroom-schema', 'delivery-cursors', 'event-cursors', 'execution-cutover-settings'].includes(kind)) continue;
    if (domain === 'bot-management' && kind === 'bots') continue;
    if (domain === 'chatroom' && ['rooms', 'messages', 'deliveries'].includes(kind)) continue;
    if (kind === 'catalog-entries' || kind === 'native-executions') {
      // Executable configuration and credential references are kept in private host settings.
      const { config, launch, ...facts } = value;
      history(store, domain, kind, facts);
    } else history(store, domain, kind, value);
  }
}

function carryConfiguredWakeups(store, records, receipts) {
  for (const { kind, value } of records) {
    const request = kind === 'reminders' && value.sourceTaskId && value.sourceMessageId;
    const routine = kind === 'routines' && value.sourceTaskId && value.sourceMessageId && !removedGovernance(value);
    const when = request ? value.dueAt : value.nextRunAt;
    if ((!request && !routine) || !Number.isFinite(Date.parse(when)) || !store.get(botRecords, value.botId)) continue;
    const tag = value.actor === 'user' ? user : actor(value.actor);
    const origin = eventRef(value.sourceMessageId);
    const posted = receipts.get(value.id);
    const due = request ? !posted && ['pending', 'sending'].includes(value.status) && !value.cancelRequested : value.enabled === true;
    const rule = { kind: 'time', at: when, ...(value.roomId ? { scope: roomRef(value.roomId) } : {}),
      ...(routine && Number.isSafeInteger(value.intervalSeconds) && value.intervalSeconds > 0 ? { interval_ms: value.intervalSeconds * 1000 } : {}) };
    store.import(wakeupRecords, { id: value.id, bot_id: value.botId, rule, next_due: due ? Date.parse(when) : null,
      enabled: Boolean(due), revision: value.revision || 1, author: tag, source_ref: origin, original_status: value.status,
      last_event_id: posted?.id ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt });
    const content = request ? value.content : value.instruction;
    if (content) notes(store, recordKey('reminder-content', value.id), botRef(value.botId),
      `history/reminders/${encodeURIComponent(value.id)}.md`, content, [origin], value);
  }
}

async function previousUsage(dataRoot, limits) {
  const path = join(dataRoot, 'usage.sqlite');
  const end = Date.now(), from = Math.floor(end / limits.period_ms) * limits.period_ms;
  return readRows(path, db => db.prepare(`SELECT data FROM model_usage WHERE started_at>=?
    OR json_extract(data,'$.finishedAt')>=?`).all(new Date(from).toISOString(), new Date(from).toISOString()).map(row => JSON.parse(row.data)));
}

function putPriorUsage(store, modelCalls, records) {
  for (const row of modelCalls) {
    const began_at = Date.parse(row.startedAt);
    const ended_at = Date.parse(row.finishedAt) || (Number.isFinite(row.latencyMs) ? began_at + row.latencyMs : began_at);
    if (!Number.isFinite(began_at) || row.status === 'pending') continue;
    store.import('platform-usage', { id: recordKey('legacy-model', row.botId, row.id), resource: 'models',
      charge_account: 'host', began_at, ended_at, reserved_tokens: Number(row.requestedOutputTokens) || 0, tokens: row.totalTokens ?? null,
      outcome: row.status, source: { origin_bot: row.botId, space: row.roomId ? roomRef(row.roomId) : botRef(row.botId) } });
  }
  for (const row of records) {
    const began_at = Date.parse(row.launchedAt || row.startedAt), ended_at = Date.parse(row.finishedAt);
    if (!Number.isFinite(began_at) || !Number.isFinite(ended_at)) continue;
    store.import('platform-usage', { id: recordKey('legacy-external', row.id), resource: 'external',
      charge_account: 'host', began_at, ended_at, reserved_tokens: 0, tokens: 0, outcome: row.status, source: { origin_bot: row.actor } });
  }
}

async function grantWorkspaces(bots, dataRoot, appRoot) {
  const workspaces = new Map(), byBot = new Map();
  for (const bot of bots) {
    const path = bot.config?.workspace;
    if (!isAbsolute(path || '')) continue;
    const resolved = await readOptional(path, realpath);
    if (!resolved || resolved === parse(resolved).root || within(dataRoot, resolved) || within(resolved, dataRoot) ||
      within(appRoot, resolved) || within(resolved, appRoot)) continue;
    if (!(await stat(resolved)).isDirectory()) continue;
    const workspaceProfileId = bot.workspaceProfileId ?? null;
    const key = recordKey(workspaceProfileId, resolved);
    let workspace = workspaces.get(key);
    if (!workspace) {
      workspace = { id: randomUUID(), path: resolved, name: basename(resolved), kind: 'workspace', write: true, revision: 1, workspaceProfileId };
      workspaces.set(key, workspace);
    }
    byBot.set(bot.id, workspace.id);
  }
  return { workspaces, byBot };
}

async function sourceRecords(root, folder) { return readRows(databasePath(root, folder), db => hasTable(db, 'records') ? allRows(db) : []); }
function values(records, kind) { return records.filter(row => row.kind === kind).map(row => row.value); }

async function convertAttachments(dataRoot, messages, publications, rooms, journal) {
  const directory = join(dataRoot, 'capabilities', 'chatroom', 'attachments');
  const directories = await readOptional(directory, path => readdir(path, { withFileTypes: true })) || [];
  const roomsById = new Map(rooms.map(room => [room.id, room]));
  const knownPublications = new Map(publications.filter(row => row.attachment?.id).map(row => [row.attachment.id, row]));
  const oldUsers = new Map();
  for (const row of messages) {
    if (row.senderId !== 'user') continue;
    for (const attachment of row.attachments || []) {
      if (!oldUsers.has(attachment.id)) oldUsers.set(attachment.id, new Set());
      oldUsers.get(attachment.id).add(roomsById.get(row.roomId)?.workspaceProfileId ?? null);
    }
  }
  for (const entry of directories) {
    const { name } = entry;
    if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) continue;
    const path = join(directory, name, 'metadata.json');
    const metadata = await readOptional(path);
    if (!metadata || metadata.id !== name || Object.hasOwn(metadata, 'ownerId')) continue;
    const publication = knownPublications.get(name);
    const originalBot = metadata.origin?.type === 'work-output' && safeId(metadata.origin.botId) ? metadata.origin.botId :
      safeId(publication?.botId) ? publication.botId : null;
    const originRoom = metadata.origin?.roomId || publication?.roomId;
    const contexts = oldUsers.get(name);
    // In the installed protocol the user upload endpoint is the only writer
    // that calls upload with no origin. A Bot publication carries its origin.
    const fromUser = !publication && !Object.hasOwn(metadata, 'origin');
    const ownerId = originalBot || (fromUser ? 'user' : null);
    const workspaceProfileId = originalBot ? roomsById.get(originRoom)?.workspaceProfileId ?? null
      : contexts?.size === 1 ? [...contexts][0] : null;
    const value = { ...metadata, ref: fileRef(name), revision: 1, ownerId, workspaceProfileId,
      ...(ownerId ? {} : { owner_status: 'unresolved' }) };
    await journal.json(`attachment:${name}`, path, value);
  }
}

export async function convertLegacyData({ dataRoot, appRoot, state, journal, deployment, defaultLimits }) {
  const domains = ['bot-management', 'chatroom', 'registry', 'gateway', 'knowledge', 'memory-management', 'filesystem', 'codex'];
  const store = new RecordStore(databasePath(dataRoot, 'capabilities/chatroom'));
  try {
    if (!journal.applied(store, 'legacy-data-ready')) {
      const old = new Map(await Promise.all(domains.map(async domain => [domain, await sourceRecords(dataRoot, `capabilities/${domain}`)])));
      const managed = old.get('bot-management');
      const bots = await Promise.all(values(managed, 'bots').map(row => readBot(dataRoot, state.previous_release, row)));
      const workspaceProfiles = values(old.get('gateway'), 'workspace-profiles');
      const { modelFor, replacedPaths } = await modelBindings(dataRoot, bots, workspaceProfiles, journal);
      const registry = old.get('registry');
      const rooms = values(old.get('chatroom'), 'rooms');
      const jobs = values(old.get('chatroom'), 'deliveries');
      const oldMessages = values(old.get('chatroom'), 'messages');
      const workspace = await grantWorkspaces(bots, dataRoot, appRoot);
      const external = await externalFacts(dataRoot, registry);
      const limits = { ...defaultLimits, bots: Math.max(defaultLimits.bots, Math.ceil((bots.length + 16) / 32) * 32), ...deployment.limits };
      const usage = await previousUsage(dataRoot, limits);
      await convertAttachments(dataRoot, oldMessages, values(old.get('filesystem'), 'file-publications'), rooms, journal);
      const botState = new Map(), material = new Map();
      await journal.step(store, 'host-identities', () => {
        const mapped = new Set(bots.map(bot => bot.id));
        for (const bot of bots) {
          const { model, model_ids } = modelFor(bot);
          const inhibited = bot.status === 'paused' || bot.runIntent === 'stopped' && !bot.firstRunPending;
          const control = inhibited ? { ...activeControl(), state: 'paused', requested_by: user,
            stop_id: recordKey('legacy-bot-stop', bot.id), stop_status: 'stopped' } : activeControl();
          store.import(botRecords, { id: bot.id, name: bot.name, instructions: bot.instructions, owner: user,
            enabled: !inhibited, control, model, revision: 1, material_index_ref: null, avatar: bot.avatar,
            workspaceProfileId: bot.workspaceProfileId ?? null, createdAt: bot.createdAt, updatedAt: bot.updatedAt });
          const workspaceId = workspace.byBot.get(bot.id);
          store.import('platform-access', { id: bot.id, model_ids, workspace_ids: workspaceId ? [workspaceId] : [], revision: 1 });
        }
        for (const item of workspaceProfiles) {
          store.import('platform-workspace-profiles', { id: item.id, name: item.name, botId: item.botId, createdAt: item.createdAt, updatedAt: item.updatedAt });
        }
        for (const item of workspace.workspaces.values()) store.import('platform-workspaces', item);
        store.import(hostLimitsRecord, { id: 'host', revision: 1, limits });
        convertRooms(store, rooms, mapped);
      });
      await journal.step(store, 'host-messages', () => convertMessages(store));
      for (const bot of bots) {
        const stateForBot = await convertBotRuns({ store, bot, deliveries: jobs.filter(job => job.botId === bot.id), journal });
        botState.set(bot.id, stateForBot || { originalTasks: [], receipts: new Map() });
        material.set(bot.id, await botMaterials(bot, { dataRoot, appRoot, journal, works: stateForBot?.works || [] }));
      }
      await journal.step(store, 'host-execution-and-material', () => {
        for (const bot of bots) {
          const stateForBot = botState.get(bot.id);
          const workspaceProfileId = bot.workspaceProfileId ?? null;
          for (const convo of stateForBot.conversations || []) store.import(conversationRecords, { ...convo, workspaceProfileId });
          for (const input of stateForBot.inputs || []) store.import('platform-events', input);
          const { files: records, selections } = material.get(bot.id);
          for (const record of records) putFile(store, record);
          if (selections.length) {
            const id = recordKey(bot.id, 'material-index');
            notes(store, id, botRef(bot.id), 'memory/migrated-index.json', { items: selections });
            store.save(botRecords, { id: bot.id, material_index_ref: fileRef(id) });
          }
        }
        importExternal(store, external, registry, botState);
        const currentPeriod = Math.floor(Date.now() / limits.period_ms) * limits.period_ms;
        putPriorUsage(store, usage, [...external.native.map(item => item.row), ...external.network]
          .filter(row => Date.parse(row.finishedAt || row.startedAt || row.launchedAt) >= currentPeriod));
        for (const node of values(old.get('knowledge'), 'nodes')) if (node.content) notes(store, recordKey('knowledge', node.id), user,
          `history/knowledge/${encodeURIComponent(node.id)}.md`, node.content, [], node);
        const relations = values(old.get('knowledge'), 'edges');
        if (relations.length) notes(store, recordKey('knowledge', 'edges'), user, 'history/knowledge/relations.json', relations);
        attachHistory(store, old);
        convertDeliveries(store, jobs, state, botState, oldMessages);
        convertExplicitPublications(store, botState, oldMessages);
        for (const bot of bots) convertPrivateCalls(store, bot, botState.get(bot.id));
        convertClientReceipts(store, oldMessages);
        carryConfiguredWakeups(store, managed, new Map(oldMessages.map(row => [row.id, row])));
      });
      for (const bot of bots) {
        const stateForBot = botState.get(bot.id), { consumed } = material.get(bot.id);
        const file = join(bot.dir, 'state.sqlite');
        if (!stateForBot || !await readOptional(file, stat)) continue;
        const db = new BotStore(file);
        try {
          await journal.step(db, `history:${bot.id}`, () => {
            const index = recordKey(bot.id, 'material-index');
            for (const { reference, item, file } of consumed) {
              const scope = [botRef(bot.id), ...item.applies_to.sort((left, right) =>
                recordKey(left.kind, left.id).localeCompare(recordKey(right.kind, right.id)))];
              const id = recordKey(index, item.id, item.revision, null, item.revision, scope.map(ref => recordKey(ref.kind, ref.id)), file.id);
              db.putRecord(R.consumption, { id, migrated: true, bot_id: bot.id, index_ref: fileRef(index), item_id: reference.id, target_ref: fileRef(file.id),
                scope, selection_revision: item.revision, material_revision: item.revision, material_ref: null,
                target_revision: file.revision, call_id: reference.toolRunId, consumed_at: reference.processedAt, outcome: 'processed', original: reference });
            }
            const retained = new Set([...Object.values(R), 'legacy-work-history', 'migration-history', 'migration-conversation-history']);
            for (const record of allRows(db.db)) {
              if (retained.has(record.kind)) continue;
              db.putRecord('migration-history', { id: recordKey(record.kind, record.value.id), original_kind: record.kind,
                original_id: record.value.id, value: record.value });
              db.deleteRecord(record.kind, record.value.id);
            }
            for (const tableName of formerBotTables) {
              if (!db.tableExists(tableName)) continue;
              for (const [index, row] of table(db.db, tableName).entries()) {
                const { kind, value } = historyEnvelope(bot.id, tableName, row, index);
                db.putRecord(kind, value);
              }
              db.db.exec(`DROP TABLE ${tableName}`);
            }
          });
        } finally { db.close(); }
      }
      await journal.step(store, 'host-remove-legacy-rows', () => {
        for (const { kind, value } of old.get('chatroom')) if (!['rooms', 'messages', 'migration-history'].includes(kind)) store.remove(kind, value.id);
      });
      for (const path of replacedPaths) if (within(join(dataRoot, 'config', 'workspaces'), path)) {
        await journal.identifyRemoval(`replaced-model-setting:${relative(dataRoot, path)}`, path);
      }
      for (const bot of bots) {
        if (bot.config) await journal.identifyRemoval(`replaced-bot-settings:${bot.id}`, join(bot.dir, 'config.json'));
      }
      await journal.step(store, 'legacy-data-ready', () => {});
    }
    for (const prefix of ['replaced-model-setting:', 'replaced-bot-settings:']) {
      for (const entry of journal.filesFor(prefix)) await journal.remove(entry.id, entry.target);
    }
    for (const domain of domains) {
      if (domain === 'chatroom') continue;
      const path = databasePath(dataRoot, `capabilities/${domain}`);
      if (!await readOptional(path, stat)) continue;
      const previous = new RecordStore(path);
      try {
        await journal.step(previous, `remove-replaced:${domain}`, () => previous.db.exec('DELETE FROM records'));
      } finally { previous.close(); }
    }
  } finally { store.close(); }
}
