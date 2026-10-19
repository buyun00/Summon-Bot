import { randomUUID } from 'node:crypto';

const TERMINAL_WORKS = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_HOPS = 4;
const now = () => new Date().toISOString();
const text = value => String(value ?? '').trim();
const pick = (object, fields) => Object.fromEntries(fields.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const AVATAR_SHAPES = new Set(['circle', 'cloud', 'square', 'star4', 'clover', 'heart', 'flower', 'drop', 'pill', 'triangle', 'pentagon', 'star6', 'hexagon']);

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  throw error;
}

function required(value, name, limit = 16000) {
  const result = text(value);
  if (!result) fail(`${name}不能为空`);
  if (result.length > limit) fail(`${name}不能超过 ${limit} 字符`);
  return result;
}

function avatarOf(value, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('头像设置必须是对象');
  const shape = value.shape ?? previous.shape ?? 'circle';
  const color = value.color ?? previous.color ?? '#8F59F9';
  const image = value.image === undefined ? (previous.image || '') : (value.image || '');
  if (!AVATAR_SHAPES.has(shape)) fail('请选择有效的 Bot 头像形状');
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail('头像颜色必须是六位色值');
  if (typeof image !== 'string' || image.length > 400000 || (image && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
    fail('头像图片需要 PNG、JPEG 或 WebP，且不超过 300 KB');
  }
  return { shape, color: color.toUpperCase(), image };
}

function iso(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('时间格式无效');
  return date.toISOString();
}

function parseReply(content) {
  const raw = text(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('模型没有返回可解析的 JSON，未执行任何动作'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型响应必须是 JSON 对象');
  if (value.actions !== undefined && !Array.isArray(value.actions)) throw new Error('模型 actions 必须是数组');
  return { reply: text(value.reply), pass: value.pass === true, actions: (value.actions || []).slice(0, 4) };
}

function historyOf(record) {
  const { history, ...snapshot } = record;
  return [...(history || []), snapshot];
}

export class SocialRuntime {
  constructor({ store, provider, emit = () => {}, createWork, agentRuntime, defaultCwd = process.cwd() }) {
    this.store = store;
    this.provider = provider;
    this.emit = emit;
    this.createWork = createWork;
    this.agentRuntime = agentRuntime;
    this.defaultCwd = defaultCwd;
    this.started = false;
    this.generation = 0;
    this.running = new Map();
    this.roomsBusy = new Map();
    this.pending = new Set();
    this.seed();
  }

  seed() {
    const bots = [
      { id: 'bot-engineer', name: '工程伙伴', role: '工程实现与工作委托', expertise: '代码调查、实现、调试、将明确工作委托给 Codex', prompt: '将用户明确的实施目标转为清楚的工作委托。先查看现有工作，避免重复开工。' },
      { id: 'bot-components', name: '组件伙伴', role: '组件与项目知识', expertise: '组件复用、接口约束、依赖关系、维护项目知识', prompt: '优先核查现有组件与知识；没有来源的结论标为待核查。' },
      { id: 'bot-qa', name: '质量伙伴', role: '验证与问题分析', expertise: '验收条件、测试、回归、区分静态分析和真实运行证据', prompt: '没做的验证不写通过，指出具体未验证项；帮助同事完善验证方法。' }
    ];
    for (const bot of bots) if (!this.store.get('bots', bot.id)) this.store.save('bots', { ...bot, status: 'active', model: 'deepseek-flash', skills: [], executor: 'codex' });
    if (!this.store.get('rooms', 'room-lobby')) this.store.save('rooms', {
      id: 'room-lobby', name: '项目大群', kind: 'group', members: ['user', ...bots.map(bot => bot.id)], status: 'active', goal: '', summary: ''
    });
  }

  need(kind, id) {
    const record = this.store.get(kind, id);
    if (!record) fail(`找不到 ${kind}/${id}`, 404);
    return record;
  }

  change(type, payload) { this.emit(type, payload); }

  state() {
    this.expireRecords();
    const jobs = this.store.list('jobs');
    const messages = this.store.list('messages');
    const lastMessages = new Map(messages.map(message => [message.roomId, message]));
    const activity = messages.filter(message => message.returnTo || message.peerReplyId || ['event', 'work'].includes(message.kind)).slice(-100);
    const activityIds = new Set(activity.map(message => message.id));
    const peerReplyIds = new Set(activity.map(message => message.peerReplyId).filter(Boolean));
    for (const message of messages) if (peerReplyIds.has(message.id) && !activityIds.has(message.id)) activity.push(message);
    const lane = name => ({ running: [...this.running.values()].filter(job => job.lane === name).length,
      queued: jobs.filter(job => job.lane === name && job.status === 'queued').length });
    return { bots: this.store.list('bots'), rooms: this.store.list('rooms').map(room => ({ ...room, lastMessage: lastMessages.get(room.id) || null })),
      activity,
      routines: this.store.list('routines'),
      knowledge: { nodes: this.store.list('nodes'), edges: this.store.list('edges') },
      runtime: { started: this.started, fast: lane('fast'), deep: lane('deep'), jobs: jobs.slice(-80) } };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.generation++;
    for (const job of this.store.list('jobs')) if (job.status === 'running') this.store.save('jobs', {
      ...job, status: 'interrupted', error: '上次服务在模型调用期间中断；可以显式重试', finishedAt: now()
    });
    // A reply can be saved just before a restart. Recreate only its missing return job.
    for (const message of this.store.list('messages')) this.queueDmReturn(message);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.pump();
  }

  async stop() {
    if (!this.started) return Promise.allSettled([...this.pending]);
    this.started = false;
    this.generation++;
    clearInterval(this.timer);
    for (const job of this.running.values()) {
      const current = this.store.get('jobs', job.id);
      if (current?.status === 'running') this.store.save('jobs', { ...current, status: 'interrupted', error: '服务已停止，模型结果未确认', finishedAt: now() });
    }
    this.running.clear();
    this.roomsBusy.clear();
    await this.agentRuntime?.stop();
    await Promise.allSettled([...this.pending]);
  }

  expireRecords() {
    const time = Date.now();
    for (const kind of ['memories', 'nodes']) for (const item of this.store.list(kind)) {
      if (item.status !== 'expired' && item.expiresAt && new Date(item.expiresAt).getTime() <= time) {
        this.store.save(kind, { ...item, status: 'expired', history: historyOf(item) });
      }
    }
  }

  tick() {
    if (!this.started) return;
    this.expireRecords();
    for (const routine of this.store.list('routines')) {
      if (!routine.enabled || new Date(routine.nextRunAt).getTime() > Date.now()) continue;
      const bot = this.store.get('bots', routine.botId);
      if (!bot || bot.status !== 'active') continue;
      try {
        this.store.transaction(() => {
          const due = routine.nextRunAt;
          this.store.save('routines', { ...routine, lastRunAt: now(), lastStatus: 'queued', nextRunAt: new Date(Date.now() + routine.intervalSeconds * 1000).toISOString() });
          this.postMessage(routine.roomId, { content: `定时职责「${routine.name}」：${routine.instruction}`, toBotId: routine.botId,
            kind: 'event', eventType: 'routine', routineId: routine.id, clientId: `routine:${routine.id}:${due}`, notify: true }, 'system');
        });
      } catch (error) {
        this.store.save('routines', { ...this.store.get('routines', routine.id), lastStatus: 'failed', error: error.message,
          nextRunAt: new Date(Date.now() + routine.intervalSeconds * 1000).toISOString() });
        this.change('routine', { id: routine.id });
      }
    }
    this.pump();
  }

  createBot(body) {
    const bot = this.store.save('bots', { name: required(body.name, '名称', 100), role: required(body.role ?? '项目协作', '职责', 1000),
      expertise: text(body.expertise), prompt: text(body.prompt), status: body.status === 'paused' ? 'paused' : 'active',
      skills: Array.isArray(body.skills) ? body.skills.map(String) : [], executor: 'codex', model: 'deepseek-flash',
      ...(body.avatar !== undefined ? { avatar: avatarOf(body.avatar) } : {}) });
    this.change('bot', bot);
    return bot;
  }

  updateBot(id, body) {
    const bot = this.need('bots', id);
    if (body.name !== undefined) required(body.name, '名称', 100);
    if (body.role !== undefined) required(body.role, '职责', 1000);
    if (body.status !== undefined && !['active', 'paused'].includes(body.status)) fail('成员状态只能是 active 或 paused');
    if (body.skills !== undefined && !Array.isArray(body.skills)) fail('skills 必须是字符串数组');
    if (body.executor !== undefined && body.executor !== 'codex') fail('首版执行器为 codex');
    const result = this.store.save('bots', { ...bot, ...pick(body, ['name', 'role', 'expertise', 'prompt', 'status', 'skills']),
      ...(body.avatar !== undefined ? { avatar: avatarOf(body.avatar, bot.avatar) } : {}), executor: 'codex', model: 'deepseek-flash' });
    this.change('bot', result);
    this.pump();
    return result;
  }

  createRoom(body, { senderId = 'user', rootId, hop = 0, sourceActionId } = {}) {
    const kind = body.kind || 'group';
    if (!['group', 'dm', 'deep'].includes(kind)) fail('房间类型无效');
    const members = [...new Set(body.members || [])];
    if (!members.length) fail('请选择至少一位成员');
    for (const id of members) if (id !== 'user' && !String(id).startsWith('executor:')) this.need('bots', id);
    if (!members.some(id => this.store.get('bots', id))) fail('房间需要至少一位 Bot');
    if (members.length > 9) fail('首版每个房间最多 8 位 Bot 和用户');
    if (kind === 'dm') {
      if (members.length !== 2) fail('私聊需要两位参与者');
      const existing = this.store.list('rooms').find(room => room.kind === 'dm' && room.members.slice().sort().join('|') === members.slice().sort().join('|'));
      if (existing) return existing;
    }
    if (body.originRoomId) this.need('rooms', body.originRoomId);
    const room = this.store.save('rooms', { name: text(body.name) || (kind === 'dm' ? '私聊' : kind === 'deep' ? '深度讨论' : '讨论群'),
      kind, members, goal: text(body.goal), originRoomId: body.originRoomId || null, originMessageId: body.originMessageId || null,
      rounds: Math.max(1, Math.min(4, Number(body.rounds) || 2)), status: 'active', summary: '', ...(sourceActionId ? { sourceActionId } : {}) });
    this.change('room', room);
    if (kind === 'deep' && room.goal) this.postMessage(room.id, { content: room.goal, rootId, hop, notify: true }, senderId);
    return room;
  }

  roomMessages(roomId) { return this.store.list('messages').filter(message => message.roomId === roomId); }

  updateRoom(id, body) {
    const room = this.need('rooms', id);
    const changes = {};
    if (body.name !== undefined) changes.name = required(body.name, '群名称', 100);
    if (body.goal !== undefined) {
      if (text(body.goal).length > 16000) fail('群目标不能超过 16000 字符');
      changes.goal = text(body.goal);
    }
    if (body.members !== undefined) {
      if (room.kind === 'dm') fail('私聊的参与者不能修改');
      if (!Array.isArray(body.members)) fail('members 必须是成员数组');
      const members = [...new Set(body.members)];
      if (!members.length || members.length > 9) fail('群需要 1 至 8 位 Bot，可包含用户');
      for (const member of members) if (member !== 'user') this.need('bots', member);
      if (!members.some(member => this.store.get('bots', member))) fail('群需要至少一位 Bot');
      if (members.filter(member => member !== 'user').length > 8) fail('群最多 8 位 Bot');
      changes.members = members;
    }
    const changedGoal = changes.goal !== undefined && changes.goal !== room.goal;
    const changedMembers = changes.members && changes.members.slice().sort().join('|') !== room.members.slice().sort().join('|');
    if (room.kind === 'deep' && (changedGoal || changedMembers)) {
      if (room.status === 'concluded') fail('已结束的深聊保留原目标与成员，请创建新的讨论', 409);
      if (this.store.list('jobs').some(job => job.roomId === id && ['queued', 'running'].includes(job.status))) {
        fail('深聊进行中，暂时不能修改目标或参与成员', 409);
      }
    }
    const result = this.store.save('rooms', { ...room, ...changes });
    this.change('room', result);
    return result;
  }

  mentioned(content, members) {
    if (/(?:^|\s)@(?:all|everyone|所有人)(?=\s|$|[，。！？:：])/i.test(content)) return members;
    return members.filter(id => {
      const bot = this.store.get('bots', id);
      if (!bot) return false;
      return [id, bot.name].some(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s，。！？:：,!?])`, 'i').test(content);
      });
    });
  }

  appendMessage(roomId, input, senderId) {
    const messageId = input.id || randomUUID();
    const message = this.store.save('messages', { id: messageId, roomId, senderId, content: required(input.content, '消息'),
      ...pick(input, ['toBotId', 'replyTo', 'attachments', 'clientId', 'eventType', 'routineId', 'workId', 'jobId', 'usage', 'model', 'returnTo', 'peerReplyId']),
      rootId: input.rootId || messageId, hop: Math.max(0, Number(input.hop) || 0), kind: input.kind || 'message' });
    this.change('message', message);
    return message;
  }

  postMessage(roomId, input, senderId = 'user') {
    const room = this.need('rooms', roomId);
    if (room.status === 'concluded') fail('讨论已结束，请建立新的讨论');
    if (input.clientId) {
      const duplicate = this.roomMessages(roomId).find(message => message.clientId === input.clientId && message.senderId === senderId);
      if (duplicate) return duplicate;
    }
    if (input.toBotId && !room.members.includes(input.toBotId)) fail('被联系成员不在该房间');
    const message = this.appendMessage(roomId, input, senderId);
    if (message.hop >= MAX_HOPS) return message;
    const active = room.members.filter(id => (room.kind === 'deep' || id !== senderId) && this.store.get('bots', id)?.status === 'active');
    const mentions = this.mentioned(message.content, active);
    const selected = input.toBotId ? active.filter(id => id === input.toBotId) : mentions.length ? mentions
      : senderId === 'user' || room.kind === 'dm' || input.notify ? active : [];
    if (room.kind === 'deep') {
      if (selected.length) this.queueDeep(room, message, selected);
    } else for (const botId of selected) this.queue({ type: 'turn', lane: 'fast', roomId, botId, messageId: message.id,
      rootId: message.rootId, hop: message.hop, routineId: message.routineId });
    this.pump();
    return message;
  }

  queue(input) {
    const id = input.id || `job:${input.type}:${input.messageId || input.roomId}:${input.botId || 'summary'}:${input.round || 0}`;
    const existing = this.store.get('jobs', id);
    if (existing) return existing;
    const job = this.store.save('jobs', { ...input, id, status: 'queued', attempts: 0 });
    this.change('job', job);
    return job;
  }

  queueDmReturn(reply) {
    if (reply.kind !== 'message' || !reply.replyTo) return false;
    const request = this.store.get('messages', reply.replyTo);
    const route = request?.returnTo;
    if (!route || reply.roomId !== request.roomId || reply.senderId !== request.toBotId || route.botId !== request.senderId) return false;
    const origin = this.store.get('rooms', route.roomId);
    const trigger = this.store.get('messages', route.messageId);
    if (!origin || !origin.members.includes(route.botId) || trigger?.roomId !== origin.id || origin.status === 'concluded') return false;
    this.queue({ id: `dm-return:${reply.id}`, type: 'dm_result', lane: 'fast', roomId: origin.id, botId: route.botId,
      messageId: trigger.id, requestMessageId: request.id, replyMessageId: reply.id,
      rootId: request.rootId, hop: Math.min(MAX_HOPS, reply.hop) });
    return true;
  }

  queueDeep(room, message, selected) {
    // A room has one bounded discussion drive. New input is visible to its remaining turns.
    const inProgress = this.store.list('jobs').some(job => job.roomId === room.id && ['queued', 'running'].includes(job.status));
    if (inProgress) return;
    for (let round = 1; round <= room.rounds; round++) for (const botId of selected) this.queue({ type: 'turn', lane: 'deep', roomId: room.id,
      botId, messageId: message.id, rootId: message.rootId, hop: message.hop, round });
    this.queue({ type: 'conclude', lane: 'deep', roomId: room.id, botId: selected[0], messageId: message.id, rootId: message.rootId, hop: message.hop });
  }

  pump() {
    if (!this.started || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      if (!this.started) return;
      const jobs = this.store.list('jobs');
      for (const lane of ['fast', 'deep']) {
        const limit = lane === 'fast' ? 3 : 1;
        for (const job of jobs) {
          if (job.status !== 'queued' || job.lane !== lane || this.roomsBusy.has(job.roomId)) continue;
          if (this.running.size >= 12 || [...this.running.values()].filter(item => item.lane === lane && !item.agentWaiting).length >= limit) break;
          const bot = this.store.get('bots', job.botId);
          if (!bot || bot.status !== 'active') {
            this.store.save('jobs', { ...job, status: 'cancelled', error: '成员不存在或已暂停', finishedAt: now() });
            continue;
          }
          const current = this.store.save('jobs', { ...job, status: 'running', startedAt: now(), attempts: job.attempts + 1 });
          const generation = this.generation;
          this.running.set(job.id, current);
          this.roomsBusy.set(job.roomId, generation);
          this.change('job', current);
          const task = this.runJob(current, generation);
          this.pending.add(task);
          task.finally(() => this.pending.delete(task));
        }
      }
    });
  }

  live(generation) { return this.started && generation === this.generation; }

  async runJob(job, generation) {
    try {
      if (job.type === 'conclude') await this.conclude(job, generation);
      else await this.turn(job, generation);
      if (!this.live(generation)) return;
      this.store.save('jobs', { ...this.store.get('jobs', job.id), status: 'completed', finishedAt: now() });
    } catch (error) {
      if (!this.live(generation)) return;
      const current = this.store.get('jobs', job.id);
      const agentRun = current.agentRunId && this.store.get('agentRuns', current.agentRunId);
      const status = ['cancelled', 'interrupted'].includes(agentRun?.status) ? agentRun.status : 'failed';
      this.store.save('jobs', { ...current, status, error: error.message, finishedAt: now() });
      this.appendMessage(job.roomId, { content: `${this.store.get('bots', job.botId)?.name || 'Bot'} 调用失败：${error.message}`,
        kind: 'error', jobId: job.id, rootId: job.rootId, hop: MAX_HOPS }, 'system');
    } finally {
      if (this.live(generation)) {
        this.running.delete(job.id);
        this.roomsBusy.delete(job.roomId);
        if (job.routineId) {
          const routine = this.store.get('routines', job.routineId);
          if (routine) this.store.save('routines', { ...routine, lastStatus: this.store.get('jobs', job.id).status });
        }
        this.change('job', this.store.get('jobs', job.id));
        this.pump();
      }
    }
  }

  async summarize(roomId, generation) {
    let room = this.need('rooms', roomId);
    const messages = this.roomMessages(roomId).filter(message => message.kind !== 'error');
    const watermark = room.summaryThrough ? messages.findIndex(message => message.id === room.summaryThrough) : -1;
    const unsummarized = messages.slice(watermark + 1);
    if (unsummarized.length <= 30) return room;
    const older = unsummarized.slice(0, -12);
    const result = await this.provider.complete({ messages: [
      { role: 'system', content: '你在压缩聊天上下文。用中文简明保留用户目标、约束、事实与来源、待办、未决分歧。不得把意见写成已验证事实。只输出摘要，不执行任何动作。' },
      { role: 'user', content: JSON.stringify({ previousSummary: room.summary || '', messages: older.map(message => ({ sender: message.senderId, content: message.content, id: message.id })) }) }
    ], deep: false, json: false, maxTokens: 900 });
    if (!this.live(generation)) return room;
    if (!text(result.content)) throw new Error('上下文摘要为空');
    room = this.store.save('rooms', { ...this.need('rooms', roomId), summary: result.content, summaryThrough: older.at(-1).id, summaryAt: now() });
    return room;
  }

  context(botId, room, messageId, { fullHistory = false } = {}) {
    // Visual profile data (especially uploaded image bytes) must stay out of model prompts.
    const bot = pick(this.need('bots', botId), ['id', 'name', 'role', 'expertise', 'prompt', 'status', 'skills', 'executor', 'model']);
    const all = this.roomMessages(room.id).filter(message => message.kind !== 'error');
    const watermark = room.summaryThrough ? all.findIndex(message => message.id === room.summaryThrough) : -1;
    const messages = fullHistory ? all : all.slice(Math.max(watermark + 1, all.length - 24));
    const trigger = this.store.get('messages', messageId);
    const memories = this.store.list('memories').filter(item => item.botId === botId && item.status !== 'expired').slice(-12);
    const found = this.search(trigger?.content || room.goal || '', botId);
    const activeNodes = found.nodes.filter(item => item.status !== 'expired');
    const nodes = activeNodes.length ? activeNodes.slice(0, 12) : this.store.list('nodes').filter(item => item.status !== 'expired').slice(-8);
    return { bot, messages, trigger, memories, nodes, edges: this.store.list('edges').filter(edge => nodes.some(node => node.id === edge.from || node.id === edge.to)).slice(-20),
      colleagues: this.store.list('bots').map(item => pick(item, ['id', 'name', 'role', 'expertise', 'status'])),
      works: this.store.list('works').filter(work => !TERMINAL_WORKS.has(work.status)).map(work => pick(work, ['id', 'botId', 'goal', 'status', 'roomId'])).slice(-12) };
  }

  systemPrompt(bot, room) {
    return `你是 Relay Bot 的长期成员「${bot.name}」，ID=${bot.id}，职责=${bot.role}，专长=${JSON.stringify(bot.expertise || '')}，技能说明=${JSON.stringify(bot.skills || [])}，执行器=${bot.executor || 'codex'}。\n${bot.prompt || ''}
用户是唯一最终权威；所有 Bot 平级。你根据自己的专业判断参与，没有中央智能主控。当前房间 ${room.name} (${room.kind})，目标：${room.goal || '日常项目协作'}。
仅依据实际提供的消息/知识/执行结果说话；区分事实、假设、意见和待核查。没有做的测试不能说通过。记忆属于你；群聊记录与共享知识属于项目。
快聊简短，不适合长分析时可提出深聊；基础调查、读写文件、搜索、命令由你自己通过工具完成，复杂专业工作可使用 work 委托 Codex。不能假装自己已读取或修改文件。用户明确要求实际工作才执行，讨论方案不自动变成实施；先查看正在进行的工作避免重复。工作完成事件只总结或指出问题，不自动重新创建同一工作。
需要联系同事时使用 dm；同事答复会带着原请求回到发起会话，你需要根据实际答复向原请求方报告，不要只向同事客套回应。没有新增贡献返回 pass:true。自动通信最多 ${MAX_HOPS} 跳，不绕过限制。深聊应提出依据、分歧和可执行结论，不重复已说内容。
${this.agentRuntime
  ? '协作操作必须实际调用 relay_action 工具，以下示例仅为该工具的 action 参数。最终 JSON 为 {"reply":"要说的话或空字符串","pass":false,"actions":[]}，actions 必须为空；不要把待执行操作写成最终回复。'
  : '只输出一个 JSON 对象：{"reply":"要说的话或空字符串","pass":false,"actions":[]}。最多 4 个 actions，缺少依据时不执行动作。允许动作：'}
{"type":"dm","targetBotId":"成员ID","message":"你自己的问题或结论"}
{"type":"deep","name":"讨论名","goal":"具体问题","members":["成员ID"],"rounds":2}
{"type":"work","goal":"明确可执行目标","cwd":"工作目录可省略","constraints":"约束","inputRefs":[]}
{"type":"memory","content":"长期经验","category":"professional或private","id":"修订时填已有ID，可省略","status":"active或expired","source":"来源","version":"适用版本"}
{"type":"knowledge","title":"条目名","content":"内容","knowledgeType":"fact或hypothesis或opinion或unverified","id":"修订时填已有ID，可省略","status":"active或disputed或expired","source":"来源","version":"适用版本"}
{"type":"relation","from":"知识节点ID","to":"知识节点ID","relation":"关系说明","source":"来源"}
{"type":"routine","name":"持续职责","instruction":"具体检查内容","intervalSeconds":3600}
不要输出未知的动作，不把普通文字当工具调用。模型固定 deepseek-flash。`;
  }

  async turn(job, generation) {
    const room = this.agentRuntime ? this.need('rooms', job.roomId) : await this.summarize(job.roomId, generation);
    if (!this.live(generation)) return;
    const context = this.context(job.botId, room, job.messageId, { fullHistory: Boolean(this.agentRuntime) });
    const dmResult = job.type === 'dm_result' ? {
      request: this.need('messages', job.requestMessageId),
      answer: this.need('messages', job.replyMessageId),
    } : null;
    let saved = this.store.get('jobs', job.id);
    let result = saved.modelResult;
    if (!result) {
      const request = { messages: [
        { role: 'system', content: this.systemPrompt(context.bot, room) },
        { role: 'user', content: JSON.stringify({ ...context, summary: room.summary || '', round: job.round || 1, ...(dmResult ? { dmResult } : {}),
          instruction: dmResult
            ? '你已收到先前私聊同事的实际答复 dmResult.answer。现在回到原请求所在会话，直接回复 trigger 的提问并转达实际答案，保留不确定项。不要再次介绍自己、只向同事道谢或只说稍后转达；不要 PASS，也不要为同一个问题重复询问。必须按指定 JSON 结构输出。'
            : '回应触发消息并考虑随后已有的同事回复。必须按指定 JSON 结构输出。' }) }
      ], deep: job.lane === 'deep', json: true, maxTokens: job.lane === 'deep' ? 6000 : 2200 };
      const response = this.agentRuntime ? await this.agentRuntime.run({ job, systemPrompt: request.messages[0].content,
        context: JSON.parse(request.messages[1].content), action: (action, index) => this.action(action, job, index), search: query => this.search(query, job.botId),
        onPhase: phase => { const current = this.running.get(job.id); if (current) { current.agentWaiting = phase !== 'model' && phase !== 'done'; this.pump(); } },
      }) : await this.provider.complete(request);
      if (!this.live(generation)) return;
      result = { ...parseReply(response.content), usage: response.usage, model: response.model };
      if (dmResult) {
        // An empty/PASS summary must not silently discard an answer already received.
        if (!result.reply) result.reply = `${this.store.get('bots', dmResult.answer.senderId)?.name || '同事'}已回复（原文）：\n${dmResult.answer.content}`;
        result.pass = false;
      }
      this.store.save('jobs', { ...this.store.get('jobs', job.id), modelResult: result });
    }
    if (result.reply) {
      const existingReply = this.store.get('messages', `reply:${job.id}`);
      const reply = existingReply || this.appendMessage(job.roomId, { id: `reply:${job.id}`, content: result.reply, replyTo: job.messageId,
        rootId: job.rootId, hop: dmResult ? Math.min(MAX_HOPS, job.hop + 1) : job.hop + 1,
        ...(dmResult ? { peerReplyId: dmResult.answer.id } : {}), jobId: job.id, usage: result.usage, model: result.model }, job.botId);
      const returned = this.queueDmReturn(reply);
      // Routed answers resume the source conversation, not a thank-you loop in the peer DM.
      if (!existingReply && !returned && !dmResult && room.kind !== 'deep' && reply.hop < MAX_HOPS) {
        const mentioned = this.mentioned(reply.content, room.members.filter(id => id !== job.botId));
        // A colleague who sent a DM receives the answer in the same shared conversation.
        if (room.kind === 'dm' && this.store.get('bots', context.trigger?.senderId)) mentioned.push(context.trigger.senderId);
        for (const botId of new Set(mentioned)) if (this.store.get('bots', botId)?.status === 'active') this.queue({ type: 'turn', lane: 'fast', roomId: room.id,
          botId, messageId: reply.id, rootId: job.rootId, hop: reply.hop });
      }
    }
    const actionErrors = [];
    this.store.save('jobs', { ...this.store.get('jobs', job.id), actionErrors });
    for (let index = 0; index < result.actions.length; index++) {
      saved = this.store.get('jobs', job.id);
      if (saved.appliedActions?.includes(index)) continue;
      if (!this.live(generation)) return;
      try {
        await this.action(result.actions[index], job, index);
        if (!this.live(generation)) return;
        const latest = this.store.get('jobs', job.id);
        this.store.save('jobs', { ...latest, appliedActions: [...(latest.appliedActions || []), index] });
      } catch (error) {
        if (!this.live(generation)) return;
        const latest = this.store.get('jobs', job.id);
        actionErrors.push({ index, error: error.message });
        this.store.save('jobs', { ...latest, actionErrors });
        this.appendMessage(job.roomId, { content: `未执行 ${text(result.actions[index]?.type)} 动作：${error.message}`, kind: 'error', jobId: job.id, rootId: job.rootId, hop: MAX_HOPS }, 'system');
      }
    }
    this.store.save('jobs', { ...this.store.get('jobs', job.id), passed: result.pass || (!result.reply && !result.actions.length) });
    if (actionErrors.length) throw new Error(`${actionErrors.length} 个动作未执行：${actionErrors.map(item => item.error).join('；')}`);
  }

  async action(action, job, index) {
    if (!action || typeof action !== 'object') fail('动作格式无效');
    const source = `message:${job.messageId}`;
    const actionId = `action:${job.id}:${index}`;
    const recordKind = { memory: 'memories', knowledge: 'nodes', relation: 'edges', routine: 'routines' }[action.type];
    if (recordKind) {
      const existing = this.store.get(recordKind, action.id || actionId);
      if (existing?.sourceActionId === actionId) return existing;
    }
    if (['dm', 'deep', 'work', 'routine'].includes(action.type) && job.hop + 1 >= MAX_HOPS) fail('已达到自动通信跳数上限');
    switch (action.type) {
      case 'dm': {
        const target = this.need('bots', action.targetBotId);
        if (target.id === job.botId) fail('不能给自己重复发送私聊');
        const room = this.createRoom({ kind: 'dm', name: `${this.need('bots', job.botId).name} ↔ ${target.name}`, members: [job.botId, target.id] });
        return this.postMessage(room.id, { content: required(action.message, '私聊消息'), clientId: actionId, rootId: job.rootId, hop: job.hop + 1, toBotId: target.id,
          returnTo: { roomId: job.roomId, messageId: job.messageId, botId: job.botId } }, job.botId);
      }
      case 'deep': {
        const existing = this.store.list('rooms').find(room => room.sourceActionId === actionId);
        if (existing) return existing;
        const room = this.createRoom({ kind: 'deep', name: text(action.name), members: [...new Set([job.botId, ...(action.members || [])])],
          goal: required(action.goal, '深聊目标'), rounds: action.rounds || 2, originRoomId: job.roomId, originMessageId: job.messageId },
        { senderId: job.botId, rootId: job.rootId, hop: job.hop + 1, sourceActionId: actionId });
        return room;
      }
      case 'work': {
        if (!this.createWork) fail('执行器尚未连接', 503);
        const existing = this.store.list('works').find(work => work.sourceActionId === actionId);
        if (existing) return existing;
        return this.createWork({ botId: job.botId, roomId: job.roomId, goal: required(action.goal, '工作目标'),
          cwd: text(action.cwd) || this.defaultCwd, constraints: text(action.constraints), inputRefs: action.inputRefs || [], sourceActionId: actionId, sourceMessageId: job.messageId });
      }
      case 'memory': return this.saveMemory(job.botId, { ...action, id: action.id || actionId, sourceActionId: actionId, source: text(action.source) || source });
      case 'knowledge': return this.saveNode({ ...action, id: action.id || actionId, sourceActionId: actionId, type: action.knowledgeType || 'unverified', source: text(action.source) || source });
      case 'relation': return this.saveEdge({ ...action, id: actionId, sourceActionId: actionId, source: text(action.source) || source });
      case 'routine': return this.saveRoutine({ ...action, id: actionId, sourceActionId: actionId, botId: job.botId, roomId: job.roomId });
      default: fail(`未知动作：${text(action.type)}`);
    }
  }

  async conclude(job, generation) {
    const room = this.need('rooms', job.roomId);
    if (room.status === 'concluded') return;
    const context = this.context(job.botId, room, job.messageId);
    const failures = this.store.list('jobs').filter(item => item.roomId === room.id && item.type === 'turn' && ['failed', 'interrupted', 'cancelled'].includes(item.status))
      .map(item => ({ botId: item.botId, round: item.round, status: item.status, reason: item.error }));
    const response = await this.provider.complete({ messages: [
      { role: 'system', content: '你是平级讨论的记录者，不拥有裁决权。根据真实讨论写中文结论，保留依据、分歧、待办和未验证项；不要把多人同意说成证据。failures 是实际未完成的成员轮次，必须承认这些成员意见缺失，不能虚构共识。信息不足就明确写未决及原因。只返回 JSON {"title":"结论标题","content":"结论正文","status":"unverified或hypothesis"}。' },
      { role: 'user', content: JSON.stringify({ goal: room.goal, summary: room.summary, messages: context.messages, sources: context.nodes, failures }) }
    ], deep: true, json: true, maxTokens: 6000 });
    if (!this.live(generation)) return;
    let parsed;
    try { parsed = JSON.parse(text(response.content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { throw new Error('深聊结论不是可解析 JSON'); }
    const caveat = failures.length ? `讨论未完整完成：${failures.map(item => `${this.store.get('bots', item.botId)?.name || item.botId} 第 ${item.round || 1} 轮 ${item.status}（${item.reason || '未完成'}）`).join('；')}。以下仅依据实际取得的发言，缺失意见仍待补充。\n\n` : '';
    const content = caveat + required(parsed.content, '深聊结论');
    const node = this.saveNode({ id: `conclusion:${room.id}`, title: text(parsed.title) || `${room.name}结论`, content,
      type: parsed.status === 'hypothesis' ? 'hypothesis' : 'unverified', source: `room:${room.id}` });
    this.appendMessage(room.id, { id: `conclusion-message:${room.id}`, content, kind: 'summary', rootId: job.rootId, hop: MAX_HOPS, usage: response.usage, model: response.model }, job.botId);
    this.store.save('rooms', { ...this.need('rooms', room.id), status: 'concluded', conclusionId: node.id, conclusion: content, concludedAt: now() });
    if (room.originRoomId && this.store.get('rooms', room.originRoomId)) this.appendMessage(room.originRoomId, {
      id: `conclusion-return:${room.id}`, content: `深聊「${room.name}」结论（来源 ${room.id}，知识 ${node.id}）：\n${content}`, kind: 'summary', rootId: job.rootId, hop: MAX_HOPS
    }, job.botId);
    this.change('room', { id: room.id });
  }

  saveMemory(botId, body) {
    this.need('bots', botId);
    const previous = body.id && this.store.get('memories', body.id);
    if (previous && previous.botId !== botId) fail('不能修订其他成员的私有记忆');
    const status = body.status || previous?.status || 'active';
    if (!['active', 'expired'].includes(status)) fail('记忆状态无效');
    const record = this.store.save('memories', { ...previous, ...pick(body, ['id', 'source', 'version', 'sourceActionId']), botId,
      content: required(body.content ?? previous?.content, '记忆内容'), category: body.category === 'private' ? 'private' : body.category || previous?.category || 'professional',
      status, expiresAt: iso(body.expiresAt, previous?.expiresAt || null), history: previous ? historyOf(previous) : [] });
    this.change('memory', record);
    return record;
  }

  saveNode(body) {
    const previous = body.id && this.store.get('nodes', body.id);
    const type = body.type || previous?.type || 'unverified';
    const status = body.status || previous?.status || 'active';
    if (!['fact', 'hypothesis', 'opinion', 'unverified'].includes(type)) fail('知识类型无效');
    if (!['active', 'disputed', 'expired'].includes(status)) fail('知识状态无效');
    const record = this.store.save('nodes', { ...previous, ...pick(body, ['id', 'source', 'version', 'sourceActionId']),
      title: required(body.title ?? previous?.title, '知识标题', 300), content: required(body.content ?? previous?.content, '知识内容'), type, status,
      expiresAt: iso(body.expiresAt, previous?.expiresAt || null), history: previous ? historyOf(previous) : [] });
    this.change('knowledge', record);
    return record;
  }

  saveEdge(body) {
    this.need('nodes', body.from);
    this.need('nodes', body.to);
    if (body.from === body.to) fail('关系需要两个不同节点');
    const relation = required(body.relation, '关系', 200);
    const duplicate = this.store.list('edges').find(edge => edge.from === body.from && edge.to === body.to && edge.relation === relation);
    const edge = this.store.save('edges', { ...duplicate, ...pick(body, ['id', 'from', 'to', 'source', 'version', 'sourceActionId']), relation, status: body.status || 'active' });
    this.change('knowledge', edge);
    return edge;
  }

  search(query, botId) {
    this.expireRecords();
    const terms = text(query).toLowerCase().split(/[\s，。！？、,;:：!?]+/).filter(term => term.length > 1);
    const matches = item => !terms.length || terms.some(term => `${item.title || ''} ${item.content || ''}`.toLowerCase().includes(term));
    const nodes = this.store.list('nodes').filter(matches);
    const memories = this.store.list('memories').filter(item => (!botId || item.botId === botId) && matches(item));
    const edges = this.store.list('edges').filter(edge => nodes.some(node => node.id === edge.from || node.id === edge.to));
    return { nodes, memories, edges };
  }

  graph(id, depth = 1) {
    const nodes = this.store.list('nodes');
    const edges = this.store.list('edges');
    if (!id) return { nodes, edges };
    this.need('nodes', id);
    const included = new Set([id]);
    for (let step = 0; step < Math.max(0, Math.min(3, Number(depth) || 1)); step++) {
      const before = new Set(included);
      for (const edge of edges) if (before.has(edge.from) || before.has(edge.to)) { included.add(edge.from); included.add(edge.to); }
    }
    return { nodes: nodes.filter(node => included.has(node.id)), edges: edges.filter(edge => included.has(edge.from) && included.has(edge.to)) };
  }

  saveRoutine(body) {
    const previous = body.id && this.store.get('routines', body.id);
    const botId = body.botId || previous?.botId;
    const roomId = body.roomId || previous?.roomId || 'room-lobby';
    this.need('bots', botId);
    const room = this.need('rooms', roomId);
    if (!room.members.includes(botId)) fail('职责成员不在目标房间');
    if (room.kind === 'deep') fail('定时职责请发送到长期群聊或私聊');
    const intervalSeconds = Math.max(60, Number(body.intervalSeconds ?? previous?.intervalSeconds ?? 3600));
    if (!Number.isFinite(intervalSeconds)) fail('周期无效');
    const record = this.store.save('routines', { ...previous, ...pick(body, ['id', 'sourceActionId']), botId, roomId,
      name: required(body.name ?? previous?.name, '职责名称', 200), instruction: required(body.instruction ?? previous?.instruction, '职责内容'),
      intervalSeconds, enabled: body.enabled !== undefined ? Boolean(body.enabled) : previous?.enabled ?? true,
      nextRunAt: iso(body.nextRunAt, previous?.nextRunAt || new Date(Date.now() + intervalSeconds * 1000).toISOString()) });
    this.change('routine', record);
    return record;
  }

  consult(work, question, targetBotId) {
    const task = this.consultNow(work, question, targetBotId);
    this.pending.add(task);
    task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }

  async consultNow(work, question, targetBotId) {
    const generation = this.generation;
    if (!this.started) throw new Error('社交服务未运行');
    if (question && typeof question === 'object') {
      targetBotId ||= question.targetBotId;
      question = question.question || question.content || question.text;
    }
    const bot = this.need('bots', targetBotId || work.botId || 'bot-engineer');
    if (bot.status !== 'active') throw new Error('咨询成员已暂停');
    const senderId = `executor:${work.id}`;
    const room = this.createRoom({ kind: 'dm', name: `执行咨询 · ${bot.name}`, members: [senderId, bot.id] });
    const questionMessage = this.appendMessage(room.id, { content: required(question, '咨询问题'), workId: work.id, toBotId: bot.id }, senderId);
    const context = this.context(bot.id, room, questionMessage.id);
    try {
      const result = await this.provider.complete({ messages: [
        { role: 'system', content: `你是 ${bot.name}，职责 ${bot.role}。专业执行器正就真实工作中途咨询你。用户是唯一最终权威，你和其他 Bot 平级。根据所给事实、记忆和共享知识回答，无法确认的内容明确说明。不能声称读过未提供的代码、完成过测试或替用户批准新的目标。只回答咨询，不创建新工作。\n${bot.prompt || ''}` },
        { role: 'user', content: JSON.stringify({ work: pick(work, ['id', 'goal', 'cwd', 'constraints', 'inputRefs']), question, context }) }
      ], deep: false, json: false, maxTokens: 1600 });
      if (!this.live(generation)) throw new Error('咨询期间服务已停止，答案未确认');
      const answer = required(result.content, '专家回复');
      this.appendMessage(room.id, { content: answer, workId: work.id, replyTo: questionMessage.id, rootId: questionMessage.id,
        usage: result.usage, model: result.model, hop: MAX_HOPS }, bot.id);
      return answer;
    } catch (error) {
      if (this.live(generation)) this.appendMessage(room.id, { content: `咨询未获得回答：${error.message}`, workId: work.id, kind: 'error', replyTo: questionMessage.id, hop: MAX_HOPS }, 'system');
      throw error;
    }
  }

  workUpdate(work) {
    if (!TERMINAL_WORKS.has(work.status) || !work.roomId || !this.store.get('rooms', work.roomId)) return;
    const id = `work-result:${work.id}:${work.status}:${work.completedAt || work.finishedAt || work.endedAt || ''}`;
    if (this.store.get('messages', id)) return;
    const result = text(work.result?.content || work.result?.summary || work.result || work.summary || work.error || '执行器没有提供结果正文');
    this.appendMessage(work.roomId, { id, content: `工作「${work.goal}」：${work.status}\n${result}`.slice(0, 16000), workId: work.id, kind: 'work', hop: MAX_HOPS }, work.botId || 'system');
  }

  async handle(method, path, body = {}, params = new URLSearchParams()) {
    let match;
    if (method === 'GET' && path === '/api/state') return this.state();
    if (method === 'GET' && path === '/api/bots') return { bots: this.store.list('bots') };
    if (method === 'POST' && path === '/api/bots') return this.createBot(body);
    if ((match = path.match(/^\/api\/bots\/([^/]+)$/)) && method === 'PATCH') return this.updateBot(decodeURIComponent(match[1]), body);
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/memories$/))) {
      const id = decodeURIComponent(match[1]); this.need('bots', id);
      if (method === 'GET') { this.expireRecords(); return { memories: this.store.list('memories').filter(item => item.botId === id) }; }
      if (method === 'POST') return this.saveMemory(id, body);
    }
    if ((match = path.match(/^\/api\/memories\/([^/]+)$/)) && method === 'PATCH') {
      const id = decodeURIComponent(match[1]); return this.saveMemory(this.need('memories', id).botId, { ...body, id });
    }
    if (method === 'GET' && path === '/api/rooms') return { rooms: this.store.list('rooms') };
    if (method === 'POST' && path === '/api/rooms') return this.createRoom(body);
    if ((match = path.match(/^\/api\/rooms\/([^/]+)$/)) && method === 'PATCH') return this.updateRoom(decodeURIComponent(match[1]), body);
    if ((match = path.match(/^\/api\/rooms\/([^/]+)\/messages$/))) {
      const id = decodeURIComponent(match[1]); const room = this.need('rooms', id);
      if (method === 'GET') return { room, messages: this.roomMessages(id), jobs: this.store.list('jobs').filter(job => job.roomId === id).slice(-30) };
      if (method === 'POST') return this.postMessage(id, body);
    }
    if ((match = path.match(/^\/api\/rooms\/([^/]+)\/conclude$/)) && method === 'POST') {
      const room = this.need('rooms', decodeURIComponent(match[1]));
      if (room.kind !== 'deep') fail('只有深聊房间需要结论');
      if (room.status === 'concluded') return room;
      const botId = room.members.find(id => this.store.get('bots', id)?.status === 'active');
      if (!botId) fail('没有可用成员');
      const running = this.store.list('jobs').find(job => job.roomId === room.id && job.type === 'conclude' && ['queued', 'running'].includes(job.status));
      if (running) return running;
      const job = this.queue({ id: randomUUID(), type: 'conclude', lane: 'deep', roomId: room.id, botId,
        messageId: this.roomMessages(room.id).at(-1)?.id, rootId: randomUUID(), hop: 0 }); this.pump(); return job;
    }
    if (method === 'GET' && path === '/api/knowledge/search') return this.search(params.get('q') || '', params.get('botId'));
    if (method === 'GET' && path === '/api/knowledge/graph') return this.graph(params.get('id'), params.get('depth'));
    if (method === 'POST' && path === '/api/knowledge/nodes') return this.saveNode(body);
    if ((match = path.match(/^\/api\/knowledge\/nodes\/([^/]+)$/)) && method === 'PATCH') {
      const id = decodeURIComponent(match[1]); this.need('nodes', id); return this.saveNode({ ...body, id });
    }
    if (method === 'POST' && path === '/api/knowledge/edges') return this.saveEdge(body);
    if (method === 'POST' && path === '/api/routines') return this.saveRoutine(body);
    if ((match = path.match(/^\/api\/routines\/([^/]+)$/)) && method === 'PATCH') {
      const id = decodeURIComponent(match[1]); this.need('routines', id); return this.saveRoutine({ ...body, id });
    }
    if (method === 'POST' && path === '/api/events') {
      const event = this.postMessage(body.roomId || 'room-lobby', { content: required(body.content, '事件内容'), toBotId: body.botId,
        kind: 'event', eventType: text(body.type) || 'manual', notify: true, clientId: body.clientId }, 'system');
      return { event, jobs: this.store.list('jobs').filter(job => job.messageId === event.id) };
    }
    if (method === 'GET' && path === '/api/jobs') return { jobs: this.store.list('jobs') };
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/retry$/)) && method === 'POST') {
      const job = this.need('jobs', decodeURIComponent(match[1]));
      if (!['failed', 'interrupted', 'cancelled'].includes(job.status)) fail('仅可重试失败、中断或取消的任务');
      if (this.need('rooms', job.roomId).status === 'concluded') fail('讨论已结束，旧任务不能继续写入；请在新的深聊中补充缺失意见', 409);
      const retry = this.store.save('jobs', { ...job, status: 'queued', error: null, finishedAt: null }); this.pump(); return retry;
    }
    return undefined;
  }
}
