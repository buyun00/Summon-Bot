import { randomUUID } from 'node:crypto';
import { fail } from '../shared/validation.mjs';
import { assertRevision, idOf, identity } from '../platform/contract.mjs';
import { botMaintenanceRoomId } from '../../roles/index.mjs';
import { projectFactSummary } from './message-summary.mjs';

function list(value, label, maximum = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(label + '格式无效');
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) fail(label + '无效');
  return value;
}

function references(value, label, kind) {
  return list(value, label).map(ref => {
    if (kind) return { kind, id: idOf(ref, kind) };
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail(label + '格式无效');
    return { kind: identifier(ref.kind, '引用类型'), id: identifier(ref.id, '引用 ID') };
  });
}

function titleOf(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 160) fail('会话名称须为 1 至 160 个字符');
  return value.trim();
}

const refKey = ({ kind, id }) => JSON.stringify([kind, id]);
const directMembers = members => members.length === 2 && members.includes('user');
const roomActivity = "(kind='messages' OR (kind='platform-events' AND json_extract(data,'$.type')='work.tool'))";
function rowMessage(row) {
  if (!row) return null;
  const message = JSON.parse(row.data);
  const { id, roomId, senderId, content, createdAt, clientId, replyTo, replyAuthorId, callId } = message;
  const author = message.author ?? message.source ?? identity(senderId);
  return { id, ref: { kind: 'event', id }, kind: 'message', roomId, senderId, content, createdAt, sequence: row.sequence,
    author, space: { kind: 'room', id: roomId }, clientId, replyTo, replyAuthorId, callId,
    ...(message.authorized_publication && { authorized_publication: message.authorized_publication }),
    attachments: (message.attachments ?? []).map(({ id: fileId, name, mimeType, size, url, previewUrl, openUrl, unavailable }) =>
      ({ id: fileId, ref: { kind: 'file', id: fileId }, name, mimeType, size, url, previewUrl, openUrl, unavailable })),
    references: message.references ?? [], mentions: message.mentions ?? [] };
}

export class ChatroomService {
  constructor({ store, manager, attachments, platform, emit = () => {} }) {
    Object.assign(this, { store, manager, attachments, platform, emit });
    store.db.exec(`
      CREATE INDEX IF NOT EXISTS records_room ON records(kind,json_extract(data,'$.roomId'),created_at);
      CREATE INDEX IF NOT EXISTS records_message_client ON records(
        json_extract(data,'$.roomId'),json_extract(data,'$.senderId'),json_extract(data,'$.clientId')
      ) WHERE kind='messages' AND json_extract(data,'$.clientId') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS records_room_summary ON records(
        json_extract(data,'$.roomId'),json_extract(data,'$.messageId')
      ) WHERE kind='room-message-summaries';
      CREATE INDEX IF NOT EXISTS records_room_reply ON records(
        json_extract(data,'$.roomId'),json_extract(data,'$.senderId'),json_extract(data,'$.replyTo')
      ) WHERE kind='messages' AND json_extract(data,'$.replyTo') IS NOT NULL;
    `);
    this.messageSummaryRows = store.db.prepare(`
      SELECT data FROM records
      WHERE kind='room-message-summaries' AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.messageId')=?
      ORDER BY rowid
    `);
    this.roomMessages = store.db.prepare(`
      SELECT rowid AS sequence,data FROM records
      WHERE kind='messages' AND json_extract(data,'$.roomId')=? ORDER BY created_at,rowid
    `);
    this.publicMessages = store.db.prepare(`
      SELECT rowid AS sequence,data FROM records WHERE kind='messages' AND json_extract(data,'$.roomId')=?
      AND rowid>? AND rowid<=? ORDER BY rowid
    `);
    this.messagePage = store.db.prepare(`
      SELECT rowid AS sequence,data FROM records
      WHERE kind='messages' AND json_extract(data,'$.roomId')=? AND (? IS NULL OR (created_at,rowid)<(?,?))
      ORDER BY created_at DESC,rowid DESC LIMIT ?
    `);
    this.latestMessage = store.db.prepare(`
      SELECT rowid AS sequence,data FROM records
      WHERE kind='messages' AND json_extract(data,'$.roomId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1
    `);
    this.messageRow = store.db.prepare("SELECT rowid AS sequence,created_at,data FROM records WHERE kind='messages' AND id=?");
    this.sentReply = store.db.prepare(`SELECT rowid AS sequence,data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.senderId')=? AND json_extract(data,'$.replyTo')=?
      ORDER BY rowid LIMIT 1`);
    store.db.exec(`CREATE INDEX IF NOT EXISTS room_observation_activity ON records(json_extract(data,'$.roomId')) WHERE ${roomActivity}`);
    const roomRange = `FROM records WHERE ${roomActivity} AND json_extract(data,'$.roomId')=?`;
    this.lastActivity = store.db.prepare(`SELECT id,rowid AS sequence ${roomRange} ORDER BY rowid DESC LIMIT 1`);
    this.lastSavedMessage = store.db.prepare(`SELECT id,rowid AS sequence ${roomRange} AND kind='messages' ORDER BY rowid DESC LIMIT 1`);
    this.activityRange = store.db.prepare(`SELECT kind,rowid AS sequence,data ${roomRange}
      AND rowid>? AND rowid<=? AND (kind='messages' OR rowid>?) ORDER BY rowid`);
    this.countMessage = store.db.prepare(`SELECT rowid AS sequence,data ${roomRange}
      AND kind='messages' AND rowid>? AND json_extract(data,'$.senderId') NOT IN ('system',?)
      ORDER BY rowid LIMIT 1 OFFSET ?`);
    this.messageByClient = store.db.prepare(`
      SELECT rowid AS sequence,data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.senderId')=? AND json_extract(data,'$.clientId')=?
      ORDER BY created_at,rowid LIMIT 1
    `);
    this.attachmentMessages = store.db.prepare(`
      SELECT DISTINCT json_extract(records.data,'$.roomId') AS roomId
      FROM records,json_each(records.data,'$.attachments') AS attachment
      WHERE records.kind='messages' AND json_extract(attachment.value,'$.id')=?
        AND COALESCE(json_extract(attachment.value,'$.grants_room_access'),1)=1
    `);
  }

  room(id, actor) {
    id = idOf(id, 'room');
    actor = identity(actor).id;
    const room = this.store.get('rooms', id);
    if (!room)
      fail('会话不存在', 404);
    if (!room.members.includes(actor)) fail('无权访问这个会话', 403);
    return room;
  }

  projectRoom(room) {
    const { id, name, members, mode, pins, revision, createdAt, updatedAt } = room;
    return { id, ref: { kind: 'room', id }, name, members, mode, pins, deletable: mode === 'group' && id !== botMaintenanceRoomId,
      workspace: room.workspace ?? null, revision, createdAt, updatedAt,
      lastMessage: rowMessage(this.latestMessage.get(id)) };
  }

  projectMessage(row) {
    const message = rowMessage(row);
    if (!message) return null;
    message.attachments = message.attachments.map(file => {
      if (!file.url) return file;
      const stored = this.attachments.find(file.id);
      return stored ? file : { ...file, unavailable: true };
    });
    return message;
  }

  rooms(actor) {
    actor = identity(actor).id;
    return this.store.list('rooms')
      .filter(room => room.members.includes(actor))
      .map(room => this.projectRoom(room));
  }

  messages(id, actor) {
    const room = this.room(id, actor);
    return this.roomMessages.all(room.id).map(rowMessage);
  }

  replyBy(roomId, senderId, eventId) {
    return rowMessage(this.sentReply.get(roomId, senderId, eventId));
  }

  publicHistory(id, actor, end = this.observationEnd(id, actor)) {
    this.room(id, actor);
    const stored = this.store.get('room-public-history', id);
    const summary = stored && stored.sequence <= end ? stored : null;
    const messages = this.publicMessages.all(id, summary?.sequence ?? 0, end).map(rowMessage);
    return { summary, messages, end };
  }

  publicMessagesRange(id, actor, afterSequence = 0, end = this.observationEnd(id, actor)) {
    this.room(id, actor);
    const messages = end > afterSequence ? this.publicMessages.all(id, afterSequence, end).map(rowMessage) : [];
    return { messages, end };
  }

  savePublicSummary(roomId, actor, previous, through, summary) {
    return this.store.transaction(() => {
      this.room(roomId, actor);
      const current = this.store.get('room-public-history', roomId);
      if ((current?.through ?? null) !== (previous?.through ?? null)) return current;
      const row = this.messageRow.get(through);
      if (!row || rowMessage(row).roomId !== roomId || row.sequence <= (current?.sequence ?? 0))
        fail('群公共摘要的原文位置已经变化', 409);
      return this.store.save('room-public-history', { id: roomId, through, sequence: row.sequence, summary, time: Date.now() });
    });
  }

  saveMessageSummary(roomId, messageId, botId, summary, evidence, visible) {
    roomId = idOf(roomId, 'room');
    messageId = identifier(messageId, '消息 ID');
    botId = identity(botId).id;
    if (typeof summary !== 'string' || !summary.trim()) return null;
    const saved = this.store.transaction(() => {
      const message = rowMessage(this.messageRow.get(messageId));
      if (message?.roomId !== roomId) return null;
      this.room(roomId, botId);
      const fact = projectFactSummary(message, summary, evidence, visible);
      if (!fact.summary) return null;
      const id = JSON.stringify([roomId, messageId, botId]);
      const updated_at = new Date().toISOString();
      return this.store.save('room-message-summaries', { id, roomId, messageId, bot_id: botId, ...fact, updated_at });
    });
    if (saved) this.emit('delivery');
    return saved;
  }

  messageSummaries(roomId, messageIds) {
    const result = {};
    if (!Array.isArray(messageIds) || !messageIds.length) return result;
    for (const messageId of messageIds) {
      const rows = this.messageSummaryRows.all(roomId, messageId);
      if (!rows.length) continue;
      result[messageId] = rows.map(row => {
        const { bot_id, summary, updated_at } = JSON.parse(row.data);
        return { bot_id, summary, updated_at };
      });
    }
    return result;
  }

  observationEnd(roomId, botId) {
    this.room(roomId, botId);
    return this.lastActivity.get(roomId)?.sequence ?? 0;
  }

  observationStart(roomId, botId) {
    const work_start = this.observationEnd(roomId, botId);
    const through = this.lastSavedMessage.get(roomId) ?? null;
    return { through, start_sequence: through?.sequence ?? 0, work_start, first_user: !through, pending: null };
  }

  countedMessage(roomId, botId, after, count) {
    this.room(roomId, botId);
    return rowMessage(this.countMessage.get(roomId, after, botId, count - 1));
  }

  observationPage(roomId, context, after, until, workStart, limit = 64) {
    this.room(roomId, context.actor);
    const events = [];
    for (const row of this.activityRange.iterate(roomId, after, until, workStart)) {
      const event = row.kind === 'messages' ? messageEvent(rowMessage(row)) : { ...JSON.parse(row.data), sequence: row.sequence };
      if (!this.platform.canReadEvent(event, context)) continue;
      if (events.length === limit) return { events, more: true };
      events.push(event);
    }
    return { events, more: false };
  }

  read({ ref, cursor, limit = 40 }, actor) {
    if (ref?.kind === 'event') {
      const event = this.projectMessage(this.messageRow.get(ref.id));
      if (!event) fail('消息不存在', 404);
      this.room(event.roomId, actor);
      return event;
    }
    if (ref?.kind !== 'room') fail('需要会话或消息引用');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('消息页大小须为 1 至 100');
    const room = this.room(ref.id, actor);
    const before = cursor == null ? null : this.messageRow.get(identifier(cursor, '消息游标'));
    if (cursor != null && (!before || rowMessage(before).roomId !== room.id)) fail('消息游标已失效', 409);
    const rows = this.messagePage.all(room.id, before?.sequence ?? null, before?.created_at ?? null, before?.sequence ?? null, limit + 1);
    const messages = rows.slice(0, limit).map(row => this.projectMessage(row)).reverse();
    return { room: this.projectRoom(room), messages, cursor: rows.length > limit ? messages[0].id : null };
  }

  validateMembers(members, actor) {
    for (const member of members) {
      if (member === actor || member === 'user') continue;
      const bot = this.manager.get(member);
      if (bot.connection_initializer || bot.archivedAt) fail('此 Bot 无法加入会话', 403);
    }
  }

  ensureMaintenanceRoom(bot) {
    if (!bot || bot.archivedAt || this.store.get('rooms', botMaintenanceRoomId)) return;
    this.createRoom({ title: 'Bot 维护群', members: [bot.id], mode: 'group' }, 'user', { id: botMaintenanceRoomId });
  }

  createRoom({ title, members, mode, workspace }, actor, { id = randomUUID() } = {}) {
    actor = identity(actor).id;
    const included = [...new Set([actor, ...list(members, '成员').map(member => identity(member).id)])];
    const saved = this.store.transaction(() => {
      if (this.store.get('rooms', id)) fail('会话 ID 已存在', 409);
      this.validateMembers(included, actor);
      mode ??= directMembers(included) ? 'direct' : 'group';
      if (mode === 'direct' && !directMembers(included)) fail('私聊必须包含用户和一位 Bot');
      const fallback = included.filter(member => member !== 'user').map(member => this.manager.get(member).name).join('、');
      const onboarding = mode === 'group' && this.manager.onboardingBot();
      if (onboarding?.enabled && !included.includes(onboarding.id)) included.push(onboarding.id);
      const room = this.store.save('rooms', {
        id, name: titleOf(title, fallback.slice(0, 160) || '新会话'), members: included, mode, pins: [], revision: 1,
        workspace: workspace == null ? null : this.platform.bindRoomWorkspace(workspace, actor, mode),
      });
      for (const member of included) if (member !== 'user') this.platform.ensureRoomBase(member, id);
      return room;
    });
    const projection = this.projectRoom(saved);
    this.emit('room', projection);
    return projection;
  }

  configureRoom(id, input, actor) {
    id = idOf(id, 'room');
    actor = identity(actor).id;
    const add = new Set(list(input.add_members, '添加成员').map(member => identity(member).id));
    const remove = new Set(list(input.remove_members, '移除成员').map(member => identity(member).id));
    if ([...add].some(member => remove.has(member))) fail('同一成员不能同时添加和移除');
    const pinAdd = references(input.pin_add, '添加置顶');
    const pinRemove = new Set(references(input.pin_remove, '移除置顶').map(refKey));
    if (pinAdd.some(ref => pinRemove.has(refKey(ref)))) fail('同一引用不能同时添加和移除');
    const saved = this.store.transaction(() => {
      const room = this.room(id, actor);
      assertRevision(room.revision, input.revision);
      const added = [...add].filter(member => !room.members.includes(member));
      const removed = room.members.filter(member => remove.has(member));
      this.validateMembers(added, actor);
      const members = [...room.members.filter(member => !remove.has(member)), ...added];
      const mode = room.mode === 'direct' && members.length > 2 ? 'group' : room.mode;
      if (mode === 'group' && room.mode === 'direct') {
        const onboarding = this.manager.onboardingBot();
        if (onboarding?.enabled && !members.includes(onboarding.id) && !remove.has(onboarding.id) &&
            !this.platform.deliveries.wasRemoved(onboarding.id, id)) {
          members.push(onboarding.id);
          added.push(onboarding.id);
        }
      }
      const pins = new Map(room.pins.map(ref => [refKey(ref), ref]));
      for (const key of pinRemove) pins.delete(key);
      for (const ref of pinAdd) {
        if (!['event', 'file'].includes(ref.kind)) fail('置顶需要消息或文件引用');
        this.assertShareable(ref, room, actor, members);
        pins.set(refKey(ref), ref);
      }
      const updated = this.store.save('rooms', {
        id, name: titleOf(input.title, room.name), members, mode, pins: [...pins.values()], revision: room.revision + 1,
        ...(input.workspace !== undefined && { workspace: this.platform.bindRoomWorkspace(input.workspace, actor, mode) }),
      });
      for (const member of removed) if (member !== 'user') this.platform.removeRoomBase(member, id);
      const changedMembers = mode !== room.mode ? members : added;
      for (const member of changedMembers) if (member !== 'user') this.platform.ensureRoomBase(member, id);
      return updated;
    });
    const projection = this.projectRoom(saved);
    this.emit('room', projection);
    return projection;
  }

  deleteGroup(id, revision, actor) {
    if (identity(actor).kind !== 'user') fail('只有宿主能删除群聊', 403);
    if (!Number.isSafeInteger(revision)) fail('删除群聊需要当前群版本', 400);
    return this.store.transaction(() => {
      const removed = this.store.get('deleted-rooms', id);
      if (removed) {
        assertRevision(removed.revision, revision);
        return { id, deleted: true };
      }
      const room = this.room(id, actor);
      assertRevision(room.revision, revision);
      if (room.mode !== 'group' || id === botMaintenanceRoomId) fail('此会话不能删除', 403);
      for (const member of room.members) if (member !== 'user') this.platform.removeRoomBase(member, id);
      this.store.remove('rooms', id);
      this.store.save('deleted-rooms', { id, revision });
      this.platform.executions.retainRoomResults(id);
      return { id, deleted: true };
    });
  }

  assertShareable(ref, room, actor, members = room.members) {
    if (ref.kind === 'event') {
      const message = rowMessage(this.messageRow.get(ref.id));
      if (message?.roomId === room.id) return message;
    }
    return this.platform.assertShareable(ref, { actor, room, members });
  }

  attachmentRooms(id) {
    return this.attachmentMessages.all(id).map(row => this.store.get('rooms', row.roomId)).filter(Boolean);
  }

  attachment(id, actor) {
    actor = identity(actor).id;
    const file = this.attachments.get(id);
    const owned = file.ownerId === actor;
    const shared = this.attachmentRooms(id).some(room => room.members.includes(actor));
    if (!owned && !shared) fail('无权读取这个附件', 403);
    return file;
  }

  send(id, input, actor, options = {}) {
    id = idOf(id, 'room');
    actor = identity(actor).id;
    const clientId = input.clientId === undefined ? undefined : identifier(input.clientId, '客户端发送 ID');
    const callId = options.callId;
    let inserted = false;
    const result = this.store.transaction(() => {
      const room = this.room(id, actor);
      const eventId = options.eventId || callId || randomUUID();
      const existing = rowMessage(this.messageRow.get(eventId));
      if (existing) {
        if (existing.roomId !== id || existing.senderId !== actor || existing.callId !== callId) fail('发送身份已被占用', 409);
        return this.messageReceipt(existing);
      }
      if (clientId) {
        const previous = rowMessage(this.messageByClient.get(id, actor, clientId));
        if (previous) return this.messageReceipt(previous);
      }
      const content = input.text === undefined ? '' : input.text;
      if (typeof content !== 'string' || content.length > 16000) fail('消息正文须为不超过 16000 个字符的文本');
      const mentions = [...new Set(list(input.mentions, '@成员').map(member => identity(member).id))];
      if (mentions.some(member => !room.members.includes(member))) fail('@对象必须是会话的当前成员');
      const [reply] = input.reply_to === undefined ? [] : references([input.reply_to], '回复', 'event');
      let parent;
      if (reply) {
        parent = rowMessage(this.messageRow.get(reply.id));
        if (parent?.roomId !== id) fail('回复对象必须是同一会话的消息');
      }
      const refs = references(input.references, '消息引用');
      for (const ref of refs) this.assertShareable(ref, room, actor);
      const attachmentRefs = references(input.attachments, '附件', 'file');
      const attachments = this.attachments.resolve(attachmentRefs, (ref, file) => {
        const sameRoom = this.attachmentRooms(ref.id).some(source => source.id === id);
        const owned = file?.ownerId === actor;
        if (file && (sameRoom || owned)) return { ...this.attachments.project(file), grants_room_access: true };
        const sharedFile = this.assertShareable(ref, room, actor);
        if (file) return { ...this.attachments.project(file), grants_room_access: false };
        if (!sharedFile?.name && !sharedFile?.path) fail('附件不存在', 404);
        return { id: ref.id, ref, name: sharedFile.name ?? sharedFile.path, size: sharedFile.size };
      });
      if (!content.trim() && !attachments.length && !refs.length) fail('请填写正文，或添加附件或引用');
      const message = this.store.save('messages', {
        id: eventId, kind: 'message', roomId: id, senderId: actor, author: identity(actor), content, attachments, references: refs, mentions,
        ...(options.authorizedFields?.length && { authorized_publication: { fields: options.authorizedFields } }),
        ...(options.workCardChange && { work_card_change: options.workCardChange }),
        replyTo: parent?.id ?? null, ...(parent ? { replyAuthorId: parent.senderId } : {}),
        ...(clientId === undefined ? {} : { clientId }), ...(callId ? { callId } : {}),
      });
      const saved = rowMessage(this.messageRow.get(message.id));
      this.platform.queueMessage(saved);
      inserted = true;
      return this.messageReceipt(saved);
    });
    if (inserted) this.emit('message', result.message);
    return result;
  }

  messageReceipt(message) {
    return { message, deliveries: this.platform.messageDeliveries(message.id) };
  }

  receiptForPublication(id, actor) {
    const message = this.projectMessage(this.messageRow.get(id));
    this.room(message.roomId, actor);
    return this.messageReceipt(message);
  }

  receipt(id, clientId, actor) {
    id = idOf(id, 'room');
    actor = identity(actor).id;
    this.room(id, actor);
    const message = this.projectMessage(this.messageByClient.get(id, actor, identifier(clientId, '客户端发送 ID')));
    if (!message) fail('尚无此发送记录', 404);
    return this.messageReceipt(message);
  }
}

export function messageEvent(message) {
  const author = message.senderId === 'system' ? { kind: 'platform', id: 'platform' } : identity(message.senderId);
  return { id: message.id, type: 'message', kind: 'event', roomId: message.roomId, space: message.space,
    ...(message.authorized_publication && { authorized_publication: message.authorized_publication }),
    author, time: message.createdAt, sequence: message.sequence, text: message.content, content: message.content,
    mentions: message.mentions, reply_to: message.replyTo, replyAuthorId: message.replyAuthorId,
    attachments: message.attachments, references: message.references, call_id: message.callId };
}
