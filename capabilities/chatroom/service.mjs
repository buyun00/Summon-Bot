import { randomUUID } from 'node:crypto';
import { fail } from '../shared/validation.mjs';
import { assertRevision, idOf, identity } from '../platform/contract.mjs';
import { botMaintenanceRoomId, groupLeadRole } from '../bot-management/roles.mjs';

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
    const refKind = identifier(ref.kind, '引用类型');
    if (refKind === 'workspace_file') {
      const workspace_id = identifier(ref.workspace_id, '工作区 ID');
      const path = typeof ref.path === 'string' && ref.path.trim() && ref.path.length <= 500 && !/[\\:\p{Cc}]/u.test(ref.path) &&
        !ref.path.split('/').some(part => !part || part === '.' || part === '..')
        ? ref.path.trim()
        : fail('工作区文件路径无效');
      return { kind: 'workspace_file', workspace_id, path };
    }
    return { kind: refKind, id: identifier(ref.id, '引用 ID') };
  });
}

function titleOf(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 160) fail('会话名称须为 1 至 160 个字符');
  return value.trim();
}

function normalizeRoomNameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

const SECRET_TARGET_KINDS = new Set(['hub_login', 'hub_register', 'hub_password', 'env', 'model_api_key', 'file_env', 'session_input']);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defaultSecretQuestions(targetKind) {
  switch (targetKind) {
    case 'hub_login':
      return [
        { id: 'username', label: '用户名', mode: 'text', required: true, field: 'username', custom_placeholder: '输入云端中枢用户名' },
        { id: 'password', label: '密码', mode: 'secret', required: true, secret: true, field: 'password', custom_placeholder: '输入登录密码' },
      ];
    case 'hub_register':
      return [
        { id: 'invite_code', label: '邀请码', mode: 'text', required: true, field: 'invite_code', custom_placeholder: '输入中枢邀请码' },
        { id: 'username', label: '用户名', mode: 'text', required: true, field: 'username', custom_placeholder: '设置登录用户名' },
        { id: 'password', label: '密码', mode: 'secret', required: true, secret: true, field: 'password', custom_placeholder: '设置登录密码' },
      ];
    case 'hub_password':
      return [
        { id: 'current_password', label: '当前密码', mode: 'secret', required: true, secret: true, field: 'current_password', custom_placeholder: '输入当前密码' },
        { id: 'new_password', label: '新密码', mode: 'secret', required: true, secret: true, field: 'new_password', custom_placeholder: '输入新密码' },
      ];
    case 'model_api_key':
      return [
        { id: 'api_key', label: 'API Key', mode: 'secret', required: true, secret: true, field: 'api_key', custom_placeholder: '输入模型 API Key' },
      ];
    case 'session_input':
      return [
        { id: 'input', label: '敏感输入', mode: 'secret', required: true, secret: true, field: 'input', custom_placeholder: '输入将直接送达执行会话的凭据' },
      ];
    default:
      return [];
  }
}

function normalizeSecretTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'env', label: '本机凭据库 (runtime.env)' };
  }
  const kind = SECRET_TARGET_KINDS.has(raw.kind) ? raw.kind : fail('隐私输入投递目标类型无效');
  const out = { kind };
  const copyStr = (key, max = 240) => {
    if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].trim().slice(0, max);
  };
  copyStr('label', 120);
  copyStr('hub_url', 240);
  copyStr('connection_id', 160);
  copyStr('provider', 80);
  copyStr('base_url', 240);
  copyStr('model', 160);
  copyStr('name', 80);
  copyStr('workspace', 500);
  copyStr('path', 240);
  copyStr('session_id', 160);
  copyStr('request_id', 160);
  if (raw.activate === true) out.activate = true;
  if (Number.isSafeInteger(raw.control_version) && raw.control_version >= 0) out.control_version = raw.control_version;
  return out;
}

function normalizePrompt(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('选择框格式无效');
  const kind = ['question', 'permission', 'confirm', 'secret'].includes(raw.kind) ? raw.kind : 'question';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : undefined;
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 400) : undefined;
  const submit_label = typeof raw.submit_label === 'string' && raw.submit_label.trim() ? raw.submit_label.trim().slice(0, 40) : undefined;
  const secret_target = kind === 'secret' ? normalizeSecretTarget(raw.secret_target) : undefined;
  const rawQuestions = Array.isArray(raw.questions) && raw.questions.length
    ? raw.questions
    : (kind === 'secret' ? defaultSecretQuestions(secret_target.kind) : []);
  if (!Array.isArray(rawQuestions) || !rawQuestions.length || rawQuestions.length > 12) {
    fail(kind === 'secret' ? '隐私输入窗须包含 1 至 12 个输入项' : '选择框须包含 1 至 12 个问题');
  }
  const seenQ = new Set();
  const questions = rawQuestions.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('选择框问题格式无效');
    const qid = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `q${idx + 1}`;
    if (seenQ.has(qid)) fail('选择框问题 ID 不能重复');
    seenQ.add(qid);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 300) : '';
    if (!label) fail('选择框问题标题不能为空');
    const fallbackMode = kind === 'secret' ? 'secret' : 'single';
    const mode = ['single', 'multi', 'text', 'secret'].includes(item.mode) ? item.mode : fallbackMode;
    const isSecret = mode === 'secret' || item.secret === true;
    const required = item.required !== false;
    const allow_custom = (mode === 'text' || mode === 'secret') ? false
      : item.allow_custom !== undefined ? Boolean(item.allow_custom)
      : kind !== 'permission';
    const custom_placeholder = typeof item.custom_placeholder === 'string' && item.custom_placeholder.trim()
      ? item.custom_placeholder.trim().slice(0, 160) : undefined;
    const field = typeof item.field === 'string' && item.field.trim() ? item.field.trim().slice(0, 80) : undefined;
    const env_name = typeof item.env_name === 'string' && item.env_name.trim() ? item.env_name.trim().slice(0, 128) : undefined;
    if (env_name && !ENV_KEY_RE.test(env_name)) fail('环境变量名格式无效');
    const default_value = !isSecret && typeof item.default_value === 'string' && item.default_value.trim()
      ? item.default_value.trim().slice(0, 300) : undefined;
    const hint = typeof item.hint === 'string' && item.hint.trim() ? item.hint.trim().slice(0, 240) : undefined;
    let options = [];
    if (mode !== 'text' && mode !== 'secret') {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 20) {
        fail('单选或多选问题须包含 1 至 20 个选项');
      }
      const seenOpt = new Set();
      options = item.options.map((opt, optIdx) => {
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) fail('选项格式无效');
        const oid = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim().slice(0, 80) : `opt${optIdx + 1}`;
        if (seenOpt.has(oid)) fail('同一问题的选项 ID 不能重复');
        seenOpt.add(oid);
        const optLabel = typeof opt.label === 'string' && opt.label.trim() ? opt.label.trim().slice(0, 160) : '';
        if (!optLabel) fail('选项名称不能为空');
        const description = typeof opt.description === 'string' && opt.description.trim()
          ? opt.description.trim().slice(0, 240) : undefined;
        const tone = ['default', 'primary', 'danger'].includes(opt.tone) ? opt.tone : 'default';
        return {
          id: oid,
          label: optLabel,
          ...(description ? { description } : {}),
          ...(opt.recommended === true ? { recommended: true } : {}),
          ...(tone !== 'default' ? { tone } : {}),
        };
      });
    }
    return {
      id: qid,
      label,
      mode,
      required,
      allow_custom,
      ...(isSecret ? { secret: true } : {}),
      ...(field ? { field } : {}),
      ...(env_name ? { env_name } : {}),
      ...(default_value ? { default_value } : {}),
      ...(hint ? { hint } : {}),
      ...(custom_placeholder ? { custom_placeholder } : {}),
      ...(options.length ? { options } : {}),
    };
  });
  return {
    kind,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(submit_label ? { submit_label } : {}),
    ...(secret_target ? { secret_target } : {}),
    questions,
  };
}

function normalizePromptResponse(raw, room, lookupMessage) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('选择框答复格式无效');
  const prompt_message_id = identifier(raw.prompt_message_id, '选择框消息 ID');
  const promptMsg = lookupMessage(prompt_message_id);
  if (!promptMsg || promptMsg.roomId !== room.id || !promptMsg.prompt) {
    fail('目标选择框不存在或不属于当前会话', 404);
  }
  const skipped = raw.skipped === true;
  if (skipped) {
    return {
      promptMsg,
      value: { prompt_message_id, skipped: true, answers: [] },
    };
  }
  if (!Array.isArray(raw.answers) || !raw.answers.length || raw.answers.length > 12) {
    fail('请至少填写一项选择结果');
  }
  const isSecretPrompt = promptMsg.prompt.kind === 'secret';
  const byId = new Map(promptMsg.prompt.questions.map(q => [q.id, q]));
  const answers = raw.answers.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('回答条目格式无效');
    const question_id = identifier(item.question_id, '问题 ID');
    const q = byId.get(question_id);
    if (!q) fail('回答对应的问题 ID 不存在');
    const isSecretField = q.mode === 'secret' || q.secret === true;
    const optMap = new Map((q.options || []).map(o => [o.id, o.label]));
    const selected_ids = Array.isArray(item.selected_ids)
      ? [...new Set(item.selected_ids.filter(v => typeof v === 'string' && optMap.has(v)))]
      : [];
    const selected_labels = selected_ids.map(oid => optMap.get(oid));
    // Never persist raw values of secret fields in chat history or Bot context.
    const custom_text = isSecretField
      ? ''
      : (typeof item.custom_text === 'string' ? item.custom_text.trim().slice(0, 4000) : '');
    if (q.mode === 'single' && selected_ids.length > 1) fail('单选题只能选择一个选项');
    return {
      question_id,
      label: q.label,
      selected_ids,
      selected_labels,
      ...(isSecretField ? { redacted: true } : {}),
      ...(custom_text ? { custom_text } : {}),
    };
  });
  let secret_delivery;
  if (isSecretPrompt && raw.secret_delivery && typeof raw.secret_delivery === 'object' && !Array.isArray(raw.secret_delivery)) {
    const d = raw.secret_delivery;
    secret_delivery = {
      ...(typeof d.target_kind === 'string' && d.target_kind.trim() ? { target_kind: d.target_kind.trim().slice(0, 60) } : {}),
      ...(typeof d.target_label === 'string' && d.target_label.trim() ? { target_label: d.target_label.trim().slice(0, 160) } : {}),
      ...(Array.isArray(d.configured_keys) ? { configured_keys: d.configured_keys.filter(k => typeof k === 'string' && k.trim()).slice(0, 20).map(k => k.trim().slice(0, 128)) } : {}),
      ...(typeof d.detail === 'string' && d.detail.trim() ? { detail: d.detail.trim().slice(0, 240) } : {}),
    };
  }
  return {
    promptMsg,
    value: {
      prompt_message_id,
      answers,
      ...(secret_delivery && Object.keys(secret_delivery).length ? { secret_delivery } : {}),
    },
  };
}

const refKey = ref => ref?.kind === 'workspace_file'
  ? JSON.stringify([ref.kind, ref.workspace_id, ref.path])
  : JSON.stringify([ref?.kind, ref?.id]);
const directMembers = members => members.length === 2 && members.includes('user');
const roomActivity = "(kind='messages' OR (kind='platform-events' AND json_extract(data,'$.type')='work.tool'))";
function rowMessage(row) {
  if (!row) return null;
  const message = JSON.parse(row.data);
  const { id, roomId, senderId, content, createdAt, clientId, replyTo, replyAuthorId, callId,
    forSessionId, originMessageId, awaitingReply, prompt, promptResponse, promptAnswer } = message;
  const author = message.author ?? message.source ?? identity(senderId);
  return { id, ref: { kind: 'event', id }, kind: 'message', roomId, senderId, content, createdAt, sequence: row.sequence,
    author, space: { kind: 'room', id: roomId }, clientId, replyTo, replyAuthorId, callId,
    ...(forSessionId ? { forSessionId } : {}),
    ...(originMessageId ? { originMessageId } : {}),
    ...(awaitingReply ? { awaitingReply: true } : {}),
    ...(prompt ? { prompt } : {}),
    ...(promptResponse ? { promptResponse } : {}),
    ...(promptAnswer ? { promptAnswer } : {}),
    ...(Array.isArray(message.acks) && message.acks.length ? { acks: message.acks } : {}),
    attachments: (message.attachments ?? []).map(({ id: fileId, name, mimeType, size, revision, url, previewUrl, openUrl, unavailable }) =>
      ({ id: fileId, ref: { kind: 'file', id: fileId }, name, mimeType, size, ...(revision !== undefined ? { revision } : {}), url, previewUrl, openUrl, unavailable })),
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
      WHERE kind='messages' AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.promptResponse') IS NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1
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
    const { id, name, members, mode, pins, revision, createdAt, updatedAt, lead_bot_id, archivedAt, auto_title_pending, origin_room } = room;
    return { id, ref: { kind: 'room', id }, name, members, mode, pins,
      deletable: mode === 'group' && id !== botMaintenanceRoomId,
      archivable: mode === 'group' && id !== botMaintenanceRoomId,
      archived_at: archivedAt || null,
      ...(lead_bot_id ? { lead_bot_id } : {}),
      ...(origin_room ? { origin_room } : {}),
      ...(auto_title_pending ? { auto_title_pending: true } : {}),
      workspace: room.workspace ?? null, revision, createdAt, updatedAt,
      lastMessage: rowMessage(this.latestMessage.get(id)) };
  }

  projectMessage(row) {
    const message = rowMessage(row);
    if (!message) return null;
    if (!message.senderName && message.senderId && message.senderId !== 'user' && message.senderId !== 'system') {
      const live = this.store.get('platform-bots', message.senderId);
      message.senderName = live?.name || this.manager.deletedName(message.senderId) || null;
    }
    message.attachments = message.attachments.map(file => {
      if (!file.url) return file;
      if (file.url.startsWith('/api/files/')) {
        const stored = this.platform.files.get(file.id);
        return stored ? file : { ...file, unavailable: true };
      }
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

  repliesTo(roomId, eventId) {
    return this.store.db.prepare(`SELECT rowid AS sequence,data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND (json_extract(data,'$.replyTo')=? OR json_extract(data,'$.originMessageId')=?)
      ORDER BY rowid`).all(roomId, eventId, eventId).map(rowMessage);
  }

  latestSequence(roomId) {
    return this.lastSavedMessage.get(roomId)?.sequence ?? 0;
  }

  messageEventFor(message) {
    return messageEvent(message);
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

  saveMessageSummary(roomId, messageId, botId, summary) {
    roomId = idOf(roomId, 'room');
    messageId = identifier(messageId, '消息 ID');
    botId = identity(botId).id;
    let text = typeof summary === 'string' ? summary.replace(/\s+/g, ' ').trim() : '';
    const saved = this.store.transaction(() => {
      const message = rowMessage(this.messageRow.get(messageId));
      if (message?.roomId !== roomId) return null;
      this.room(roomId, botId);
      const missingNames = (message.attachments ?? []).map(file => file.name).filter(name => name && !text.includes(name));
      if (missingNames.length) {
        const suffix = `附件${missingNames.map(name => `「${name}」`).join('、')}`;
        text = text ? `${text} ${suffix}` : suffix;
      }
      if (!text && message.references?.length) text = `附有 ${message.references.length} 项引用`;
      text = text.slice(0, 240);
      if (!text) return null;
      const id = JSON.stringify([roomId, messageId, botId]);
      const updated_at = new Date().toISOString();
      return this.store.save('room-message-summaries', { id, roomId, messageId, bot_id: botId, summary: text, updated_at });
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
    const room = this.store.get('rooms', roomId);
    const hasLead = Boolean(room?.lead_bot_id) || (room?.members || []).some(member =>
      member !== 'user' && this.store.get('platform-bots', member)?.built_in_role?.id === groupLeadRole);
    return { through, start_sequence: through?.sequence ?? 0, work_start, first_user: !through && !hasLead, pending: null };
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
      const row = this.messageRow.get(ref.id);
      const event = this.projectMessage(row);
      if (!event) fail('消息不存在', 404);
      const actorId = identity(actor).id;
      const raw = JSON.parse(row.data);
      const shared = Array.isArray(raw.shared_rooms) && raw.shared_rooms.some(rid => {
        const sharedRoom = this.store.get('rooms', rid);
        return sharedRoom && (actorId === 'user' || sharedRoom.members.includes(actorId));
      });
      if (!shared) this.room(event.roomId, actor);
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
      if (bot.archivedAt) fail('此 Bot 无法加入会话', 403);
    }
  }

  ensureMaintenanceRoom({ defaultWorkspaceId = null } = {}) {
    const existing = this.store.get('rooms', botMaintenanceRoomId);
    const egg = this.manager.eggBot();
    if (!existing) {
      const members = egg?.enabled ? [egg.id] : [];
      return this.createRoom({
        title: 'Summon',
        members,
        mode: 'group',
        workspace: defaultWorkspaceId || undefined,
        lead_name: 'Summon',
        skip_welcome: true,
      }, 'user', { id: botMaintenanceRoomId });
    }
    let changed = false;
    const next = { ...existing };
    const members = [...(next.members || [])];
    if (!members.includes('user')) { members.unshift('user'); changed = true; }
    let leadBotId = next.lead_bot_id || members.find(member =>
      member !== 'user' && this.store.get('platform-bots', member)?.built_in_role?.id === groupLeadRole);
    let createdLead = null;
    if (!leadBotId) {
      createdLead = this.manager.createGroupLead({ roomId: botMaintenanceRoomId, roomName: 'Summon', leadName: 'Summon' });
      leadBotId = createdLead.id;
      const insertAt = members.includes('user') ? members.indexOf('user') + 1 : 0;
      if (!members.includes(leadBotId)) members.splice(insertAt, 0, leadBotId);
      next.lead_bot_id = leadBotId;
      changed = true;
    } else if (!next.lead_bot_id) {
      next.lead_bot_id = leadBotId;
      changed = true;
    }
    if (egg?.enabled && !members.includes(egg.id)) { members.push(egg.id); changed = true; }
    if (!next.workspace && defaultWorkspaceId) {
      try {
        next.workspace = this.platform.bindRoomWorkspace(defaultWorkspaceId, 'user', 'group');
        changed = true;
      } catch {}
    }
    if (changed) {
      next.members = members;
      next.revision = (next.revision ?? 0) + 1;
      this.store.save('rooms', next);
      for (const member of members) if (member !== 'user') this.platform.ensureRoomBase(member, botMaintenanceRoomId);
      if (createdLead) this.platform.emit('bot', this.manager.view(createdLead, { kind: 'user', id: 'user' }));
      this.emit('room', this.projectRoom(next));
    }
    return this.projectRoom(next);
  }

  findDuplicateGroup(name, excludeId = null) {
    const targetKey = normalizeRoomNameKey(name);
    if (!targetKey) return null;
    return this.store.list('rooms').find(item =>
      item.mode === 'group' && item.id !== excludeId && normalizeRoomNameKey(item.name) === targetKey) || null;
  }

  uniqueGroupTitle(baseTitle, excludeId = null) {
    const existingKeys = new Set(
      this.store.list('rooms')
        .filter(item => item.mode === 'group' && item.id !== excludeId)
        .map(item => normalizeRoomNameKey(item.name)),
    );
    const base = String(baseTitle || '新群聊').trim().slice(0, 160) || '新群聊';
    if (!existingKeys.has(normalizeRoomNameKey(base))) return base;
    let index = 2;
    while (true) {
      const suffix = ` ${index++}`;
      const candidate = `${base.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
      if (!existingKeys.has(normalizeRoomNameKey(candidate))) return candidate;
    }
  }

  createRoom({ title, members, mode, workspace, lead_name, lead_duty, skip_welcome, auto_title, origin_room, opening_message }, actor, { id = randomUUID() } = {}) {
    actor = identity(actor).id;
    const explicitMembers = [...new Set(list(members, '成员').map(member => identity(member).id))];
    const hasGroupSignals = Boolean(
      lead_name || lead_duty || auto_title === true || origin_room || opening_message || workspace != null || id === botMaintenanceRoomId,
    );
    let createdLead = null;
    let openingMessage = null;
    const saved = this.store.transaction(() => {
      if (this.store.get('rooms', id)) fail('会话 ID 已存在', 409);
      if (mode === undefined) {
        const directCandidate = [...new Set([actor, ...explicitMembers])];
        mode = actor === 'user' && !hasGroupSignals && directMembers(directCandidate) ? 'direct' : 'group';
      }
      let requested;
      if (mode === 'direct') {
        requested = [...new Set([actor, ...explicitMembers])];
        if (!directMembers(requested)) fail('私聊必须包含用户和一位 Bot');
      } else {
        // Creating a group Room on behalf of the host does NOT force a Bot caller
        // to become a member (or hijack lead_bot_id) unless explicitly listed.
        requested = [...new Set(['user', ...explicitMembers])];
      }
      this.validateMembers(requested, actor);
      let originRoomRef = null;
      if (origin_room !== undefined && origin_room !== null) {
        const originId = idOf(origin_room, 'room');
        const originRecord = this.store.get('rooms', originId);
        if (!originRecord || !this.platform.canReadSpace(identity(actor), { kind: 'room', id: originId })) {
          fail('来源群聊不存在或无权访问', 404);
        }
        originRoomRef = { kind: 'room', id: originId };
      }
      const isStandardGroup = mode === 'group' && id !== botMaintenanceRoomId;
      const autoNameGroup = isStandardGroup && (
        auto_title === true
        || title === undefined
        || (skip_welcome === true && requested.length === 1 && !lead_name)
      );
      let roomName;
      if (autoNameGroup) {
        roomName = this.uniqueGroupTitle('新群聊');
      } else if (title !== undefined) {
        const requestedName = titleOf(title, '新会话');
        if (mode === 'group') {
          const dup = this.findDuplicateGroup(requestedName);
          if (dup) {
            fail(dup.archivedAt
              ? `已有同名已归档群聊「${dup.name}」，请换一个名称`
              : `群聊名称「${dup.name}」已存在，请换一个名称`, 409);
          }
          roomName = requestedName;
        } else {
          roomName = requestedName;
        }
      } else {
        const fallback = requested.filter(member => member !== 'user').map(member => this.manager.get(member).name).join('、');
        roomName = fallback.slice(0, 160) || '新会话';
      }
      const included = [...requested];
      let leadBotId = null;
      if (isStandardGroup || (mode === 'group' && id === botMaintenanceRoomId)) {
        // A group-lead with a different home_room_id belongs to its own home room
        // and must never hijack lead_bot_id or swallow lead_name of a new group.
        const existingLead = (!lead_name && !lead_duty) ? included.find(member => {
          if (member === 'user') return false;
          const bot = this.store.get('platform-bots', member);
          return bot?.built_in_role?.id === groupLeadRole && (!bot.home_room_id || bot.home_room_id === id);
        }) : null;
        if (existingLead) {
          leadBotId = existingLead;
        } else {
          const leadBot = this.manager.createGroupLead({
            roomId: id,
            roomName,
            leadName: lead_name,
            leadDuty: lead_duty,
            pendingAutoName: autoNameGroup && !lead_name,
          });
          createdLead = leadBot;
          leadBotId = leadBot.id;
          const insertAt = included.includes('user') ? included.indexOf('user') + 1 : 0;
          if (!included.includes(leadBot.id)) included.splice(insertAt, 0, leadBot.id);
        }
        const egg = this.manager.eggBot();
        if (egg?.enabled && !included.includes(egg.id)) included.push(egg.id);
      }
      const boundWorkspace = workspace == null ? null : this.platform.bindRoomWorkspace(workspace, actor, mode);
      const room = this.store.save('rooms', {
        id, name: roomName, members: included, mode, pins: [], revision: 1,
        ...(leadBotId ? { lead_bot_id: leadBotId } : {}),
        ...(originRoomRef ? { origin_room: originRoomRef } : {}),
        ...(autoNameGroup ? { auto_title_pending: true } : {}),
        workspace: boundWorkspace,
      });
      for (const member of included) if (member !== 'user') this.platform.ensureRoomBase(member, id);
      if (opening_message !== undefined && opening_message !== null) {
        const rawOpening = typeof opening_message === 'string' ? { text: opening_message } : opening_message;
        const openingText = typeof rawOpening?.text === 'string' ? rawOpening.text : '';
        if (!openingText.trim() || openingText.length > 16000) fail('开场交接消息须为 1 至 16000 个字符的文本');
        const openingMentions = [...new Set(list(rawOpening.mentions, '@成员').map(member => identity(member).id))];
        if (openingMentions.some(member => !included.includes(member))) fail('开场交接消息的 @对象必须是新群成员');
        const openingRefs = references(rawOpening.references, '消息引用');
        for (const ref of openingRefs) this.assertShareable(ref, room, actor, included);
        const openingAttachmentRefs = references(rawOpening.attachments, '附件', 'file');
        const openingAttachments = this.attachments.resolve(openingAttachmentRefs, (ref, file) => {
          const owned = file?.ownerId === actor;
          if (file && owned) return { ...this.attachments.project(file), grants_room_access: true };
          const sharedFile = this.assertShareable(ref, room, actor, included);
          if (file) return { ...this.attachments.project(file), grants_room_access: false };
          if (!sharedFile?.name && !sharedFile?.path) fail('附件不存在', 404);
          return {
            id: ref.id,
            ref,
            name: sharedFile.name ?? sharedFile.path,
            size: sharedFile.size,
            ...(sharedFile.revision !== undefined ? { revision: sharedFile.revision } : {}),
            url: sharedFile.url || `/api/files/${encodeURIComponent(ref.id)}/download`,
          };
        });
        const senderName = actor === 'user' ? '宿主' : this.store.get('platform-bots', actor)?.name || null;
        const openId = randomUUID();
        this.store.save('messages', {
          id: openId,
          kind: 'message',
          roomId: id,
          senderId: actor,
          ...(senderName ? { senderName } : {}),
          author: identity(actor),
          content: openingText,
          attachments: openingAttachments,
          references: openingRefs,
          mentions: openingMentions,
          replyTo: null,
        });
        const savedOpening = rowMessage(this.messageRow.get(openId));
        this.platform.recordRoomMessageActivity?.(savedOpening);
        this.platform.queueMessage(savedOpening);
        openingMessage = this.projectMessage(this.messageRow.get(openId));
      } else if (isStandardGroup && leadBotId && !skip_welcome) {
        const leadRecord = this.store.get('platform-bots', leadBotId);
        const wsLabel = boundWorkspace?.name || boundWorkspace?.path || '';
        const welcomeText = wsLabel
          ? `我是「${roomName}」的群主控，已绑定目录「${wsLabel}」，EggBot 已就位。直接说需求就行。`
          : `我是「${roomName}」的群主控，EggBot 已就位。直接说你想做什么就行。`;
        const openId = randomUUID();
        this.store.save('messages', {
          id: openId,
          kind: 'message',
          roomId: id,
          senderId: leadBotId,
          ...(leadRecord?.name ? { senderName: leadRecord.name } : {}),
          author: identity(leadBotId),
          content: welcomeText,
          attachments: [],
          references: [],
          mentions: [],
          replyTo: null,
        });
        openingMessage = this.projectMessage(this.messageRow.get(openId));
      }
      return room;
    });
    if (createdLead) {
      this.platform.emit('bot', this.manager.view(createdLead, { kind: 'user', id: 'user' }));
    }
    const projection = this.projectRoom(saved);
    this.emit('room', projection);
    if (openingMessage) this.emit('message', openingMessage);
    return projection;
  }

  configureRoom(id, input, actor) {
    id = idOf(id, 'room');
    actor = identity(actor).id;
    const add = new Set(list(input.add_members, '添加成员').map(member => identity(member).id));
    const remove = new Set(list(input.remove_members, '移除成员').map(member => identity(member).id));
    if (remove.has('user')) fail('不能移除宿主用户', 403);
    if ([...add].some(member => remove.has(member))) fail('同一成员不能同时添加和移除');
    const pinAdd = references(input.pin_add, '添加置顶');
    const pinRemove = new Set(references(input.pin_remove, '移除置顶').map(refKey));
    if (pinAdd.some(ref => pinRemove.has(refKey(ref)))) fail('同一引用不能同时添加和移除');
    const saved = this.store.transaction(() => {
      const room = this.room(id, actor);
      if (room.archivedAt) fail('该群聊已归档，请先移出归档后再修改', 409);
      assertRevision(room.revision, input.revision);
      const added = [...add].filter(member => !room.members.includes(member));
      const removed = room.members.filter(member => remove.has(member));
      this.validateMembers(added, actor);
      const members = [...room.members.filter(member => !remove.has(member)), ...added];
      const mode = room.mode === 'direct' && members.length > 2 ? 'group' : room.mode;
      const nextName = titleOf(input.title, room.name);
      if (mode === 'group' && input.title !== undefined && normalizeRoomNameKey(nextName) !== normalizeRoomNameKey(room.name)) {
        const dup = this.findDuplicateGroup(nextName, id);
        if (dup) {
          fail(dup.archivedAt
            ? `已有同名已归档群聊「${dup.name}」，请换一个名称`
            : `群聊名称「${dup.name}」已存在，请换一个名称`, 409);
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
        id, name: nextName, members, mode, pins: [...pins.values()], revision: room.revision + 1,
        ...(input.title !== undefined && room.auto_title_pending ? { auto_title_pending: false } : {}),
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

  archiveRoom(id, revision, actor) {
    id = idOf(id, 'room');
    if (identity(actor).kind !== 'user') fail('只有宿主能归档群聊', 403);
    const saved = this.store.transaction(() => {
      const room = this.room(id, actor);
      if (room.mode !== 'group' || id === botMaintenanceRoomId) fail('此会话不能归档', 403);
      if (revision !== undefined) assertRevision(room.revision, revision);
      if (room.archivedAt) return room;
      return this.store.save('rooms', { id, archivedAt: new Date().toISOString(), revision: room.revision + 1 });
    });
    const projection = this.projectRoom(saved);
    this.emit('room', projection);
    return projection;
  }

  restoreRoom(id, revision, actor) {
    id = idOf(id, 'room');
    if (identity(actor).kind !== 'user') fail('只有宿主能恢复群聊', 403);
    const saved = this.store.transaction(() => {
      const room = this.room(id, actor);
      if (revision !== undefined) assertRevision(room.revision, revision);
      if (!room.archivedAt) return room;
      return this.store.save('rooms', { id, archivedAt: null, revision: room.revision + 1 });
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
    let updatedPromptMessage = null;
    const result = this.store.transaction(() => {
      const room = this.room(id, actor);
      if (room.archivedAt) fail('该群聊已归档，请先移出归档后再发送消息', 409);
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
      const prompt = normalizePrompt(input.prompt);
      const promptRes = normalizePromptResponse(input.prompt_response, room, msgId => rowMessage(this.messageRow.get(msgId)));
      const rawMentions = list(input.mentions, '@成员').map(member => identity(member).id);
      if (promptRes && promptRes.promptMsg.senderId !== 'user' && promptRes.promptMsg.senderId !== 'system' &&
          room.members.includes(promptRes.promptMsg.senderId) && !rawMentions.includes(promptRes.promptMsg.senderId)) {
        rawMentions.push(promptRes.promptMsg.senderId);
      }
      const mentions = [...new Set(rawMentions)];
      if (mentions.some(member => !room.members.includes(member))) fail('@对象必须是会话的当前成员');
      const replyTarget = input.reply_to !== undefined ? input.reply_to : promptRes?.value.prompt_message_id;
      const [reply] = replyTarget === undefined ? [] : references([replyTarget], '回复', 'event');
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
        return {
          id: ref.id,
          ref,
          name: sharedFile.name ?? sharedFile.path,
          size: sharedFile.size,
          ...(sharedFile.revision !== undefined ? { revision: sharedFile.revision } : {}),
          url: sharedFile.url || `/api/files/${encodeURIComponent(ref.id)}/download`,
        };
      });
      if (!content.trim() && !attachments.length && !refs.length && !prompt && !promptRes) fail('请填写正文，或添加附件、引用或选择框');
      const forSessionId = input.for_session_id ? identifier(input.for_session_id, '关联会话 ID') : null;
      const [originRef] = input.origin_message_id === undefined ? [] : references([input.origin_message_id], '关联原消息', 'event');
      const originMessageId = originRef?.id ?? parent?.originMessageId ?? (parent?.senderId === 'user' ? parent.id : null);
      const awaitingReply = input.awaiting_reply === true || Boolean(prompt);
      if (actor !== 'user' && Number.isSafeInteger(options.expectedSequence)) {
        const latestSeq = this.latestSequence(id);
        if (latestSeq > options.expectedSequence) {
          const ownCalls = options.ownRunCallIds instanceof Set ? options.ownRunCallIds : new Set();
          const newer = this.publicMessages.all(id, options.expectedSequence, latestSeq)
            .map(rowMessage)
            .filter(msg => !(msg.senderId === actor && msg.callId && ownCalls.has(msg.callId)));
          if (newer.length) {
            return {
              sent: false,
              status: 'room_sequence_changed',
              expected_sequence: options.expectedSequence,
              latest_sequence: latestSeq,
              new_messages: newer.slice(-8).map(msg => ({
                id: msg.id,
                sequence: msg.sequence,
                sender_id: msg.senderId,
                author: msg.author,
                text: msg.content.slice(0, 8000),
                reply_to: msg.replyTo,
                mentions: msg.mentions,
                created_at: msg.createdAt,
              })),
              guidance: 'New room messages arrived while you were composing. Read them carefully: if the question is already fully answered and no correction or delta is needed, stay silent; otherwise send only the concise delta or correction.',
            };
          }
        }
      }
      const senderName = actor === 'user' ? '宿主' : this.store.get('platform-bots', actor)?.name || null;
      const message = this.store.save('messages', {
        id: eventId, kind: 'message', roomId: id, senderId: actor, ...(senderName ? { senderName } : {}), author: identity(actor), content, attachments, references: refs, mentions,
        replyTo: parent?.id ?? null, ...(parent ? { replyAuthorId: parent.senderId } : {}),
        ...(forSessionId ? { forSessionId } : {}),
        ...(originMessageId ? { originMessageId } : {}),
        ...(awaitingReply ? { awaitingReply: true } : {}),
        ...(prompt ? { prompt } : {}),
        ...(promptRes ? { promptResponse: promptRes.value } : {}),
        ...(clientId === undefined ? {} : { clientId }), ...(callId ? { callId } : {}),
      });
      if (promptRes) {
        this.store.save('messages', {
          id: promptRes.promptMsg.id,
          promptAnswer: {
            by: actor,
            messageId: eventId,
            answeredAt: new Date().toISOString(),
            ...(promptRes.value.skipped ? { skipped: true } : {}),
            ...(promptRes.value.secret_delivery ? { secret_delivery: promptRes.value.secret_delivery } : {}),
            answers: promptRes.value.answers,
          },
        });
        updatedPromptMessage = this.projectMessage(this.messageRow.get(promptRes.promptMsg.id));
      }
      const saved = rowMessage(this.messageRow.get(message.id));
      this.platform.recordRoomMessageActivity?.(saved);
      if (!options.skipDelivery) this.platform.queueMessage(saved);
      inserted = true;
      return this.messageReceipt(saved);
    });
    if (updatedPromptMessage) this.emit('message', updatedPromptMessage);
    if (inserted) this.emit('message', result.message);
    return result;
  }

  ackMentionedMessage(roomId, messageId, botId, label = '收到') {
    if (!roomId || !messageId || !botId) return null;
    let updated = null;
    this.store.transaction(() => {
      const row = this.messageRow.get(messageId);
      if (!row) return;
      const msg = JSON.parse(row.data);
      if (msg.roomId !== roomId || msg.senderId === botId) return;
      const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
      if (!mentions.includes(botId)) return;
      const current = Array.isArray(msg.acks) ? msg.acks : [];
      if (current.some(item => item && item.botId === botId)) return;
      const nextAcks = [...current, { botId, label: String(label || '收到').slice(0, 16), at: new Date().toISOString() }];
      this.store.save('messages', { id: messageId, acks: nextAcks });
      updated = this.projectMessage(this.messageRow.get(messageId));
    });
    if (updated) this.emit('message', updated);
    return updated;
  }

  messageReceipt(message) {
    return { message, deliveries: this.platform.messageDeliveries(message.id) };
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
    author, time: message.createdAt, sequence: message.sequence, text: message.content, content: message.content,
    mentions: message.mentions, reply_to: message.replyTo, replyAuthorId: message.replyAuthorId,
    ...(message.forSessionId ? { for_session_id: message.forSessionId } : {}),
    ...(message.originMessageId ? { origin_message_id: message.originMessageId } : {}),
    ...(message.awaitingReply ? { awaiting_reply: true } : {}),
    ...(message.prompt ? { prompt: message.prompt } : {}),
    ...(message.promptResponse ? { prompt_response: message.promptResponse } : {}),
    ...(message.promptAnswer ? { prompt_answer: message.promptAnswer } : {}),
    attachments: message.attachments, references: message.references, call_id: message.callId };
}
