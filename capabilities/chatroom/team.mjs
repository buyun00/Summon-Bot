import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, required, pick, now } from '../shared/validation.mjs';
import { activeDuties, Staffing, staffingArtifacts, staffingPolicyVersion, staffingProject, staffingScope, staffingSnapshot } from './staffing.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const activeWork = work => ['active', 'waiting', 'blocked'].includes(work.status);
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const stoppingPending = results => results.some(result => result.taskId && !terminal.has(result.status) || result.external?.some(item => !terminal.has(item.status)));
const dutyActions = new Set(['create', 'invite', 'assign']);
const staffingActions = new Set([...dutyActions, 'close-duty']);
const staffingBatchSize = 8;
const staffingInstruction = [
  '先读 chatroom_team_read、bots_list 和必要本群原文。理解领域、项目阶段、目标和近期交付链：从材料、下游、实际失败与后续接续判断哪里需要清晰责任。用该领域常见分工帮助发现候选；只用本项目证据决定。普通聊天或只有点子时可以没有候选。',
  '每项写具体负责对象与边界、可验收结果、何时参与、要保留的上下文和谁已有能力且可接。一次性事情优先现有成员或独立 work。选择独立成员时，说明让现有成员另开 work 会具体损失什么；已确认持续责任或真实独立判断、并行和维护收益可当轮登记。无需先凑人数或等多次纠正。',
  '先对比现有和结清过的职责。换了名称、同一对象的同一责任或延续旧工作时沿用 dutyKey；区分生产责任与真正不同的独立复核。按实际匹配列可用成员，角色模板可选。资料用本群已发布的原件和来源，群外工作与未执行的承诺不是交付证据。',
  '用 chatroom_team_manage action=assess 保存零到多项 candidates、领域与阶段、交付链及判断依据。当前投递自动绑定来源、操作键和项目。候选引用用户原话和真实回执；旧批产物是背景材料。结束的阶段可用 close 候选结清已有 dutyKey。分工服务登记负责人；获授权的具体动作由接力派发。不要在分工时预做、复述或公开复核业务结果。',
].join('\n');

export function groupTeam(members, manager, input = {}) {
  const eggBotId = 'bot-eggbot';
  manager.get(eggBotId);
  const leadBotId = input.leadBotId || members.find(id => id !== 'user' && id !== eggBotId && manager.get(id).status === 'active') || 'bot-entry';
  if (leadBotId === eggBotId || manager.get(leadBotId).status !== 'active') fail('Choose an available project lead');
  for (const id of [leadBotId, eggBotId]) if (!members.includes(id)) members.push(id);
  return { leadBotId, eggBotId, state: input.projectMode === 'project' ? 'active' : 'idle', requirements: '', deadlineAt: null,
    reviewIntervalSeconds: 900, auditIntervalSeconds: 604800, nextReviewAt: null, lastReviewAt: null,
    lastAuditAt: null, lastReviewMessageId: null, duties: [], revision: 1 };
}

/** The room owns shared project decisions. Each Bot still owns its work and history. */
export class TeamService {
  constructor(chatroom, { invoke } = {}) {
    this.chatroom = chatroom;
    this.invoke = invoke;
    this.projectEvidenceChecked = new Map();
    this.staffing = new Staffing(this);
  }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }
  room(id, actor) {
    const room = this.chatroom.need('rooms', id);
    if (room.kind !== 'group' || !room.team) fail('This conversation is not a team project');
    if (actor !== 'controller' && !room.members.includes(actor)) fail('Not a room member', 403);
    return room;
  }
  change(room, patch, expectedRevision) {
    const current = this.chatroom.need('rooms', room.id);
    if (expectedRevision !== undefined && current.team.revision !== expectedRevision) fail('Team changed; read its current revision', 409);
    const updated = this.store.save('rooms', { id: room.id, ...patch,
      team: { ...current.team, ...patch.team, revision: current.team.revision + 1 } });
    this.chatroom.emit('room', updated); return updated;
  }
  source(room, messageId) {
    const message = messageId ? this.store.get('messages', messageId) : this.chatroom.messages(room.id).findLast(item => item.senderId === 'user');
    if (messageId && message?.roomId !== room.id) fail('Source message is not in this room');
    return message ? { type: 'room-message', roomId: room.id, messageId: message.id, actor: message.senderId } : null;
  }
  async works(room, botId) {
    return this.manager.readState(botId, db => (db?.listRecords('works') || []).filter(work => work.sources?.some(source => source.roomId === room.id)));
  }
  staffingRoom(room) {
    return staffingProject(room);
  }
  skipOrdinarySource(room, messageId) {
    const state = this.store.get('team-staffing', room.id);
    const pending = (state?.pending || []).filter(signal => signal.key !== 'user:' + messageId);
    this.store.save('staffing-ordinary-sources', { id: messageId, roomId: room.id });
    if (state && pending.length !== state.pending?.length) this.store.save('team-staffing', { id: room.id, pending,
      ...(pending.length ? {} : { firstAt: null, readyAt: null }) });
  }
  staffingPublications(roomId, evidence) {
    const dispatches = evidence.filter(signal => signal.kind === 'work-dispatch' && signal.ownerBotId && signal.operationId);
    if (!dispatches.length) return [];
    return this.chatroom.messages(roomId).flatMap(message => {
      if (message.eventType !== 'work_result') return [];
      const dispatch = dispatches.find(signal => signal.messageId === message.replyTo && signal.workId === message.workId &&
        signal.ownerBotId === message.senderId && staffingArtifacts(message).some(item => item.operationId === signal.operationId));
      return dispatch ? [{ messageId: message.id, sourceMessageId: message.replyTo, workId: message.workId, operationId: dispatch.operationId,
        publishedAt: message.createdAt, attachments: staffingArtifacts(message).filter(item => item.operationId === dispatch.operationId) }] : [];
    });
  }
  noteStaffing(room, signals) {
    if (!this.staffingRoom(room) || !signals.length) return;
    const state = this.store.get('team-staffing', room.id);
    signals = signals.filter(signal => !state?.recentKeys?.includes(signal.key));
    if (!signals.length) return;
    const pending = new Map((state?.pending || []).map(signal => [signal.key, signal]));
    for (const signal of signals) pending.set(signal.key, signal);
    const firstAt = state?.firstAt || Date.now();
    const latestUserMessageId = signals.findLast(signal => signal.kind === 'user-update')?.messageId || state?.latestUserMessageId || null;
    this.store.save('team-staffing', { id: room.id, pending: [...pending.values()].slice(-staffingBatchSize), latestUserMessageId,
      firstAt, readyAt: Math.min(Date.now() + 2000, firstAt + 8000) });
  }
  queueStaffing(room, jobs) {
    const state = this.store.get('team-staffing', room.id);
    if (!this.staffingRoom(room)) {
      if (state && state.lastTeamState !== room.team.state) this.store.save('team-staffing', { id: room.id,
        lastTeamState: room.team.state, scope: null, pending: [], firstAt: null, readyAt: null });
      return false;
    }
    const bot = this.manager.get(room.team.eggBotId);
    if (bot.status !== 'active' || bot.runIntent === 'stopped' && !bot.firstRunPending ||
        jobs.some(job => (job.teamStaffing || job.teamReview || job.teamIntroduction) && !terminal.has(job.status))) return false;
    const scope = staffingScope(room);
    const baseline = state?.policyVersion !== staffingPolicyVersion || JSON.stringify(state?.scope) !== JSON.stringify(scope);
    if (state?.readyAt > Date.now() || !baseline && !state?.pending?.length) return false;
    // Read a saved project once under the current policy; subsequent tasks use
    // new material, with the bounded delivery snapshot available via team read.
    const recent = baseline ? staffingSnapshot(this.chatroom, room) : [];
    const changes = state?.pending?.length ? state.pending : recent;
    const currentUser = changes.findLast(signal => signal.kind === 'user-update');
    if (currentUser && jobs.some(job => job.messageId === currentUser.messageId && !job.observation && !job.teamStaffing &&
        !terminal.has(job.status))) return false;
    const evidence = [...new Map([...recent, ...(state?.recentSignals || []), ...changes].map(signal => [signal.key, signal])).values()];
    const latestUserMessageId = state?.latestUserMessageId || recent.findLast(signal => signal.kind === 'user-update')?.messageId || null;
    const ids = new Set(changes.map(signal => signal.messageId));
    const trigger = this.chatroom.messages(room.id).findLast(message => ids.has(message.id));
    if (trigger?.roomId !== room.id) return false;
    const sequence = (state?.sequence || 0) + 1;
    this.store.transaction(() => {
      const job = this.chatroom.enqueue(trigger, room.team.eggBotId, { id: 'team-staffing:' + room.id + ':' + sequence,
        teamStaffing: { reason: baseline ? 'project-snapshot' : 'new-evidence', evidence, scope, latestUserMessageId,
          changeKeys: changes.map(signal => signal.key), policyVersion: staffingPolicyVersion },
        workId: null, priority: 'background', instruction: staffingInstruction });
      this.store.save('team-staffing', { id: room.id, sequence, lastTeamState: room.team.state, lastDeliveryId: job.id,
        scope, policyVersion: staffingPolicyVersion, latestUserMessageId,
        recentKeys: [...new Set([...(state?.recentKeys || []), ...evidence.map(signal => signal.key)])].slice(-2 * staffingBatchSize),
        recentSignals: evidence.slice(-2 * staffingBatchSize),
        pending: [], firstAt: null, readyAt: null });
    });
    return true;
  }
  linkWork(room, item, trigger, signals) {
    if (!item.routedDutyKey || !signals.length) return;
    const duty = activeDuties(room, item.botId).find(candidate => candidate.dutyKey === item.routedDutyKey);
    if (!duty) return;
    const dispatches = signals.filter(signal => signal.kind === 'work-dispatch' && signal.ownerBotId === item.botId);
    if (!dispatches.length) return;
    const bindings = dispatches.map(({workId, operationId}) => ({ workId, operationId, sourceMessageId: trigger.id, botId: item.botId }));
    const reports = this.chatroom.messages(room.id).filter(message => bindings.some(binding => binding.workId === message.workId &&
      message.senderId === binding.botId && message.replyTo === binding.sourceMessageId &&
      staffingArtifacts(message).some(artifact => artifact.operationId === binding.operationId)));
    this.addDutyEvidence(room, [duty], [trigger, ...reports], bindings, reports.flatMap(staffingArtifacts));
  }
  linkResult(room, message) {
    const artifacts = staffingArtifacts(message);
    const linked = (room.team.duties || []).filter(duty => duty.workBindings?.some(binding => binding.workId === message.workId &&
      binding.botId === message.senderId && binding.sourceMessageId === message.replyTo &&
      artifacts.some(artifact => artifact.operationId === binding.operationId)));
    if (linked.length) this.addDutyEvidence(room, linked, [message], [], artifacts);
  }
  addDutyEvidence(room, linked, messages, bindings, artifacts) {
    const sourceRefs = messages.map(message => ({ type: 'room-message', roomId: room.id, messageId: message.id, actor: message.senderId }));
    const merge = (left, right, key) => [...new Map([...(left || []), ...right].map(item => [key(item), item])).values()];
    const duties = room.team.duties.map(duty => !linked.includes(duty) ? duty : {
      ...duty, sourceRefs: merge(duty.sourceRefs, sourceRefs, item => item.messageId),
      workBindings: merge(duty.workBindings, bindings, item => item.operationId),
      workIds: [...new Set([...(duty.workIds || []), ...bindings.map(item => item.workId)])],
      artifacts: merge(duty.artifacts, artifacts, item => item.id),
    });
    if (JSON.stringify(duties) !== JSON.stringify(room.team.duties)) this.change(room, { team: { duties } }, room.team.revision);
  }
  startReview(room, interval = room.team.reviewIntervalSeconds) {
    return { state: 'active', reviewFromMessageId: this.chatroom.latestProjectMessage(room.id)?.id || null,
      nextReviewAt: new Date(Date.now() + interval * 1000).toISOString() };
  }
  async includeProject(room) {
    if (room.team.state !== 'idle' || room.projectMode === 'chat' || !String(room.goal || '').trim()) return room;
    if (room.projectMode === 'project') return this.change(room, { team: this.startReview(room) }, room.team.revision);
    const latest = this.chatroom.latestRoomMessage.get(room.id)?.data;
    const members = room.members.filter(id => this.manager.store.get('bots', id));
    const marker = JSON.stringify([room.goal, room.team.revision, latest && JSON.parse(latest).id, members]);
    if (this.projectEvidenceChecked.get(room.id) === marker) return room;
    const sourcesByProject = new Map();
    for (const id of members) {
      const actions = await this.manager.readState(id, db => {
        if (!db) return [];
        const projects = new Map(db.listRecords('works').filter(work => work.project?.id)
          .map(work => [work.id, work.project.nativeProjectId || work.project.id]));
        return db.listRecords('work-events').flatMap(event => {
          const { source, production } = event.authorization || {}, project = projects.get(event.workId);
          return project && event.kind === 'request' && event.receipt?.accepted && source?.actor === 'user' &&
            source.roomId === room.id && production?.roomId === room.id && production.messageId === source.replyTo ? [{ project, messageId: source.replyTo }] : [];
        });
      });
      for (const { project, messageId } of actions) {
        const message = this.store.get('messages', messageId);
        if (message?.roomId !== room.id || message.senderId !== 'user') continue;
        if (!sourcesByProject.has(project)) sourcesByProject.set(project, new Set());
        sourcesByProject.get(project).add(messageId);
      }
    }
    this.projectEvidenceChecked.set(room.id, marker);
    const current = this.chatroom.need('rooms', room.id);
    if (current.team.revision !== room.team.revision || current.goal !== room.goal || current.projectMode !== room.projectMode ||
      current.members.length !== room.members.length || current.members.some(id => !room.members.includes(id))) return current;
    if ([...sourcesByProject.values()].some(sources => sources.size >= 2))
      return this.change(current, { team: this.startReview(current) }, current.team.revision);
    return current;
  }
  async read(input, actor, source) {
    const room = this.room(input.roomId, actor);
    const staffing = source?.metadata?.teamStaffing === true;
    if (staffing && (source.roomId !== room.id || actor !== room.team.eggBotId)) fail('Staffing reads only its own room', 403);
    const members = await Promise.all(room.members.filter(id => id !== 'user').map(async id => {
      const bot = this.manager.get(id), works = await this.works(room, id);
      return { ...pick(bot, ['id', 'name', 'roleId', 'role', 'expertise', 'status', 'runIntent', 'firstRunPending', 'lifecycle', 'skills']),
        ...(staffing ? { activeRoomWorkCount: works.filter(activeWork).length, allowedTools: bot.allowedTools || [] } : {}),
        works: (staffing ? works.slice(-4) : works).map(work => ({ ...(staffing ?
          { ...pick(work, ['id', 'productionStage', 'status']), goal: String(work.goal || '').slice(0, 360) } :
          pick(work, ['id', 'goal', 'progress', 'responsibility', 'productionStage', 'status', 'waiting', 'lastError', 'updatedAt'])),
          sourceMessageIds: [...new Set((work.sources || []).filter(source => source.roomId === room.id && source.actor === 'user')
            .map(source => source.replyTo).filter(Boolean))].slice(-6) })) };
    }));
    const entries = await readdir(join(this.manager.releaseRoot, 'roles'), { withFileTypes: true });
    const roles = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const role = JSON.parse(await readFile(join(this.manager.releaseRoot, 'roles', entry.name, 'role.json'), 'utf8'));
      return pick(role, staffing ? ['id', 'name', 'role', 'skills'] : ['id', 'name', 'role', 'skills', 'tools']);
    }));
    const messages = this.chatroom.messages(room.id), jobs = this.chatroom.jobs(room.id);
    const pendingDuties = this.store.list('team-operations').filter(item => item.roomId === room.id && item.dutyKey && ['pending', 'waiting'].includes(item.status))
      .map(item => pick(item, ['action', 'botId', 'dutyKey', 'operationId', 'source', 'status']));
    const latest = this.staffing.latest(room.id);
    const issues = this.store.list('team-issues').filter(issue => issue.roomId === room.id).slice(-40);
    if (staffing) {
      const assessment = this.staffing.forDelivery(this.store.get('deliveries', source.input?.metadata?.deliveryId));
      return { room: pick(room, ['id', 'name', 'goal', 'status', 'members', 'team']), members, availableRoles: roles, pendingDuties,
        dutyActions: this.chatroom.dutyActions.view(room.id),
        issues: issues.filter(issue => issue.status === 'open'),
        staffing: { recentEvidence: staffingSnapshot(this.chatroom, room),
          ...(latest ? { lastAssessment: this.staffing.view(latest) } : {}),
          ...(assessment ? { assessment: this.staffing.view(assessment) } : {}) },
        history: 'Use chatroom_read for original same-room messages and exact published text attachments.' };
    }
    const usage = messages.reduce((total, message) => total + Number(message.usage?.totalTokens || message.usage?.total || 0), 0);
    return { room: pick(room, ['id', 'name', 'goal', 'status', 'members', 'team']), members, availableRoles: roles,
      issues, ...(latest ? { staffing: { lastAssessment: this.staffing.view(latest) } } : {}),
      pendingDuties, dutyActions: this.chatroom.dutyActions.view(room.id),
      activity: { messageCount: messages.length, lastMessageId: messages.at(-1)?.id || null, reportedTokens: usage,
        jobs: jobs.filter(job => !terminal.has(job.status)).map(job => pick(job, ['id', 'botId', 'taskId', 'workId', 'status', 'startedAt', 'error', 'deferredReason'])) },
      routines: this.manager.store.list('routines').filter(routine => routine.roomId === room.id).map(routine => pick(routine, ['id', 'botId', 'name', 'enabled', 'intervalSeconds', 'nextRunAt', 'lastRunAt', 'lastStatus', 'pendingCount'])),
      source: this.source(room), history: 'Use chatroom_read with message IDs/cursors for original evidence; activity is not proof of progress.' };
  }
  async raise(input, actor) {
    const room = this.room(input.roomId, actor), operationId = required(input.operationId, 'operationId', 128);
    const id = JSON.stringify([room.id, actor, operationId]);
    const kind = input.kind || 'collaboration', title = required(input.title, 'title', 200), message = required(input.message, 'message', 10000);
    const previous = this.store.get('team-issues', id);
    if (previous && (previous.title !== title || previous.message !== message || previous.kind !== kind)) fail('operationId belongs to a different concern', 409);
    const source = this.source(room, input.sourceMessageId);
    let targetBotId = input.targetBotId || (['staffing', 'lifecycle', 'collaboration', 'improvement', 'handoff'].includes(kind) ? room.team.eggBotId : room.team.leadBotId);
    if (targetBotId === actor) targetBotId = actor === room.team.eggBotId ? room.team.leadBotId : room.team.eggBotId;
    if (!room.members.includes(targetBotId) || this.manager.get(targetBotId).status !== 'active') fail('Concern recipient is unavailable');
    const issue = previous || this.store.save('team-issues', { id, roomId: room.id, actor, targetBotId, kind, title, message, source, status: 'open' });
    const posted = await this.chatroom.post(room.id, { clientId: `team-issue:${id}`, toBotId: issue.targetBotId, purpose: 'request', kind: 'event', eventType: 'team_issue',
      content: `团队协作问题：${title}\n${message}\n请从原目标和当前职责判断，查证后处理；不要仅转述或默认新增 Bot。问题ID：${id}`,
      sourceRefs: source ? [source] : [] }, actor === 'controller' ? 'user' : actor);
    this.store.save('team-issues', { id, messageId: posted.id });
    if (!previous && actor !== room.team.eggBotId &&
        ['staffing', 'dependency', 'collaboration'].includes(kind) && source &&
        this.chatroom.staffingEvidence(this.store.get('messages', source.messageId)))
      this.noteStaffing(this.room(room.id, actor), [{ key: 'issue:' + id, kind: 'team-issue', messageId: source.messageId, issueId: id }]);
    return { ...issue, messageId: posted.id, accepted: true, resolved: issue.status === 'resolved' };
  }
  async pauseWork(room, botId, operation, workId) {
    const works = (await this.works(room, botId)).filter(work => (activeWork(work) || operation.stoppingWorkIds?.includes(work.id)) && (!workId || work.id === workId));
    if (operation.status === 'waiting' && works.some(work => operation.stoppingWorkIds?.includes(work.id) && work.status !== 'paused')) fail('Work resumed or changed during handoff; discuss the new state before pausing it again', 409);
    operation.stoppingWorkIds = [...new Set([...(operation.stoppingWorkIds || []), ...works.map(work => work.id)])];
    operation.stoppingTurns ||= {};
    this.store.save('team-operations', { id: operation.id, stoppingWorkIds: operation.stoppingWorkIds, stoppingTurns: operation.stoppingTurns });
    const jobs = this.chatroom.jobs(room.id).filter(job => job.botId === botId && !terminal.has(job.status) && (!workId || job.workId === workId));
    const paused = await this.manager.pauseProject(botId, { roomId: room.id, workIds: operation.stoppingWorkIds, taskIds: jobs.map(job => job.taskId).filter(Boolean), messageIds: jobs.map(job => job.id) });
    const results = [...paused.tasks];
    for (const work of works) {
      const external = [];
      for (const binding of work.bindings || []) if (binding.type === 'codex-desktop') {
        try {
          const observed = await this.invoke('codex', 'read', [binding.id, {}]);
          const turn = observed.observed?.currentTurn;
          if (turn?.id && !observed.observed.stale && !terminal.has(turn.status)) {
            const expected = operation.stoppingTurns[binding.id];
            if (expected && expected !== turn.id) { external.push({ bindingId: binding.id, status: 'changed_turn', expectedTurnId: expected, currentTurnId: turn.id }); continue; }
            operation.stoppingTurns[binding.id] = turn.id;
            this.store.save('team-operations', { id: operation.id, stoppingTurns: operation.stoppingTurns });
            await this.invoke('codex', 'interrupt', [binding.id, { operationId: `team:${operation.id}:${work.id}`, expectedTurnId: turn.id }]);
            const after = await this.invoke('codex', 'read', [binding.id, {}]);
            external.push({ bindingId: binding.id, turnId: turn.id, status: after.observed?.currentTurn?.id === turn.id && terminal.has(after.observed.currentTurn.status) ? after.observed.currentTurn.status : 'interrupt_requested' });
          } else external.push({ bindingId: binding.id, status: observed.work?.status || 'unknown' });
        } catch (error) { external.push({ bindingId: binding.id, status: 'unknown', error: error.message }); }
      }
      results.push({ workId: work.id, status: 'paused', external });
    }
    for (const job of jobs.filter(job => !job.taskId)) {
      const receipt = await this.manager.readState(botId, db => db?.listMessages().find(message => message.sourceMessageId === job.id));
      if (receipt) this.store.save('deliveries', { id: job.id, taskId: receipt.taskId, status: 'accepted' });
      else this.store.save('deliveries', { id: job.id, status: 'cancelled', finishedAt: now(), error: 'Unstarted input paused by project handoff' });
    }
    return results;
  }
  async manage(input, actor, taskSource, plannedDuty) {
    if (input.action === 'assess') return this.staffing.assess(input, actor, taskSource);
    let room = this.room(input.roomId, actor);
    const action = required(input.action, 'action', 40), reason = required(input.reason, 'reason', 3000);
    const coordinator = actor === 'controller' || actor === room.team.eggBotId;
    if (!coordinator && !(actor === room.team.leadBotId && ['project', 'assign', 'resolve'].includes(action))) fail('Ask this room’s EggBot to manage its members', 403);
    const operationId = required(input.operationId, 'operationId', 128), key = JSON.stringify([room.id, actor, operationId]);
    const body = canonical(input);
    let operation = this.store.get('team-operations', key);
    if (operation && operation.input !== body) fail('operationId belongs to another team action', 409);
    if (operation?.result) return operation.result;
    if (operation?.rejection) fail(operation.rejection.message, operation.rejection.status);
    const staffing = taskSource?.metadata?.teamStaffing === true;
    const suppliedKey = input.dutyKey === undefined ? null : required(input.dutyKey, 'dutyKey', 80).toLowerCase();
    const dutyKey = suppliedKey || operation?.dutyKey || (dutyActions.has(action) ?
      room.team.duties.find(duty => duty.botId === input.botId && duty.state !== 'closed' && !duty.dutyProfile)?.dutyKey || 'duty.' + randomUUID() : null);
    if (dutyKey && !/^[a-z0-9][a-z0-9._-]*$/.test(dutyKey)) fail('Choose a stable duty key made of letters, digits, dots, hyphens or underscores');
    if (!plannedDuty && actor === room.team.eggBotId && this.staffingRoom(room) && dutyActions.has(action))
      fail('Staffing decisions are applied through this room’s current assessment', 403);
    const checkStaffing = current => {
      if (!staffing) return;
      const message = input.sourceMessageId && this.store.get('messages', input.sourceMessageId);
      const egg = this.manager.get(actor);
      if (actor !== current.team.eggBotId || taskSource.roomId !== current.id || !this.staffingRoom(current) ||
          egg.status !== 'active' || egg.runIntent !== 'running' ||
          !plannedDuty || !staffingActions.has(action) || !Number.isSafeInteger(input.expectedRevision) ||
          message?.roomId !== current.id || message.senderId === 'system' || message.observationReply || !suppliedKey)
        fail('Staffing needs the current project, revision, original evidence and a stable duty key for assignment', 403);
      if (JSON.stringify(staffingScope(current)) !== JSON.stringify(plannedDuty.scope))
        fail('The assessed project scope is no longer current', 409);
    };
    checkStaffing(room);
    if (dutyActions.has(action)) required(input.responsibility, 'responsibility', 4000);
    if (action === 'create') {
      required(input.prompt, 'prompt', 16000); required(input.name, 'name', 100);
      if (staffing && (input.cwd || input.botId && operation?.botId !== input.botId && !room.team.duties.some(duty =>
          duty.dutyKey === dutyKey && duty.botId === input.botId && duty.state === 'provisioning')))
        fail('Staffing creates only a private workspace and the reserved duty identity', 403);
    }
    const issue = action === 'resolve' ? this.store.get('team-issues', input.issueId) : null;
    if (!operation) {
      if (input.expectedRevision !== undefined && input.expectedRevision !== room.team.revision) fail('Team changed; read current state', 409);
      if (staffing && ['invite', 'assign'].includes(action)) {
        const bot = this.manager.get(required(input.botId, 'botId', 128));
        if (action === 'invite' && room.members.includes(bot.id)) fail('Member already belongs to this room; use assign for a real duty change', 409);
        if (action === 'assign' && (!room.members.includes(bot.id) || bot.status !== 'active')) fail('Choose a current available member', 409);
      }
      if (dutyActions.has(action) && dutyKey && (room.team.duties.some(duty => duty.dutyKey === dutyKey && duty.botId !== input.botId) ||
          this.store.list('team-operations').some(item => item.roomId === room.id && item.dutyKey === dutyKey &&
            ['pending', 'waiting'].includes(item.status))))
        fail('This duty already has an owner or unresolved action; use the existing member or original operation', 409);
      const record = { id: key, action, actor, roomId: room.id, operationId, input: body, source: this.source(room, input.sourceMessageId),
        ...(dutyActions.has(action) && dutyKey ? { dutyKey } : {}), ...(staffing ? { staffingDeliveryId: taskSource.input?.metadata?.deliveryId } : {}),
        fromBotId: room.team.leadBotId, botId: input.botId || (action === 'create' ? `bot-${randomUUID()}` : null) };
      if (action === 'resolve' && issue?.roomId !== room.id) {
        const rejection = { status: 404, message: 'Unknown room issue' };
        this.store.save('team-operations', { ...record, status: 'rejected', rejection });
        fail(rejection.message, rejection.status);
      }
      operation = this.store.save('team-operations', { ...record, status: 'pending' });
    }
    let result;
    const botId = operation.botId;
    const row = plannedDuty?.row;
    const dutyRefs = row?.sourceRefs || (operation.source ? [operation.source] : []);
    const handoff = row?.outcome ? ['交付：' + row.outcome, '完成条件：' + row.acceptance,
      '参与时机：' + row.participation, '续用材料：' + row.retainedContext].join('\n') : '';
    const placeDuty = (members, responsibility, state = 'active') => {
      const previous = room.team.duties.find(item => item.dutyKey === dutyKey);
      if (previous?.botId && previous.botId !== botId) fail('This responsibility already has another owner', 409);
      if (previous?.operationId === operationId && previous.state === state) return room;
      const duty = { ...previous, botId, dutyKey, responsibility, state, source: operation.source, operationId,
        ...(state === 'active' ? { assignedAt: now(), closedAt: null } : {}),
        ...(plannedDuty ? { assessmentId: plannedDuty.assessmentId, ...this.staffing.dutyEvidence(previous, row) } : {}) };
      return this.change(room, { ...(members ? { members } : {}),
        team: { duties: [...room.team.duties.filter(item => item.dutyKey !== dutyKey), duty] } });
    };
    if (['invite', 'create'].includes(action)) {
      const responsibility = required(input.responsibility, 'responsibility', 4000);
      if (action === 'create') {
        if (plannedDuty && !activeDuties(room, botId).some(duty => duty.dutyKey === dutyKey && duty.operationId === operationId))
          room = placeDuty(null, responsibility, 'provisioning');
        const prompt = required(input.prompt, 'prompt', 16000);
        await this.manager.create({ id: botId, name: required(input.name, 'name', 100), roleId: input.roleId || 'default', prompt,
          ...(plannedDuty ? { role: row.name, expertise: row.subject + '；' + row.boundary } : { cwd: input.cwd }),
          lifecycle: { kind: 'temporary', state: 'active', originRoomId: room.id, createdBy: actor, reason } },
        plannedDuty ? { roomId: room.id, dutyKey } : undefined);
      }
      const bot = this.manager.get(botId);
      if (bot.status !== 'active' || bot.archivedAt || bot.lifecycle?.state === 'dormant') fail('Member is paused or retired; do not silently resume it', 409);
      room = this.room(room.id, actor); checkStaffing(room);
      if (!plannedDuty || action === 'create' || bot.firstRunPending)
        await this.manager.start(botId, plannedDuty ? { respectStop: true } : undefined);
      room = this.room(room.id, actor); checkStaffing(room);
      if (plannedDuty && !await this.staffing.available(botId, row, room)) fail('The selected member is unavailable or lacks the authorized tools', 409);
      room = placeDuty([...new Set([...room.members, botId])], responsibility);
      const notify = plannedDuty ? this.chatroom.append.bind(this.chatroom) : this.chatroom.post.bind(this.chatroom);
      const message = await notify(room.id, { clientId: `team-join:${key}`, toBotId: botId, kind: 'event', purpose: 'request',
        content: `你加入此项目并承接：${responsibility}\n项目目标：${room.goal}\n要求：${room.team.requirements}${handoff ? '\n' + handoff : ''}\n先用 chatroom_team_read 读取团队，再按来源核对当前议题。已有工作沿原工作和授权推进。分工通知只提供职责。`,
        sourceRefs: dutyRefs }, 'system');
      result = { bot: this.manager.get(botId), room, messageId: message.id, responsibility };
    } else if (action === 'assign') {
      if (!room.members.includes(botId) || botId === 'user') fail('Choose a current member');
      if (plannedDuty && this.manager.get(botId).firstRunPending &&
          await this.staffing.available(botId, row, room, { firstRun: true })) await this.manager.start(botId, { respectStop: true });
      if (plannedDuty && !await this.staffing.available(botId, row, room)) fail('The selected member is unavailable or lacks the authorized tools', 409);
      const responsibility = required(input.responsibility, 'responsibility', 4000);
      room = placeDuty(null, responsibility);
      const notify = plannedDuty ? this.chatroom.append.bind(this.chatroom) : this.chatroom.post.bind(this.chatroom);
      const message = await notify(room.id, { clientId: `team-assign:${key}`, toBotId: botId, purpose: 'request', kind: 'event',
        content: `项目责任调整：${responsibility}\n依据：${reason}${handoff ? '\n' + handoff : ''}\n沿已有工作和实际授权继续，先查当前团队与原始要求。`, sourceRefs: dutyRefs }, 'system');
      result = { room, messageId: message.id };
    } else if (action === 'close-duty') {
      const duty = room.team.duties.find(item => item.dutyKey === dutyKey && item.botId === botId);
      if (!duty) fail('Choose an existing responsibility and its owner');
      if (duty.operationId !== operationId) room = this.change(room, { team: { duties: room.team.duties.map(item =>
        item.dutyKey !== dutyKey ? item : { ...item, ...(row ? this.staffing.dutyEvidence(item, row) : {}),
          state: 'closed', closedAt: now(), closeSource: operation.source, operationId }) } });
      result = { room, dutyKey, historyRetained: true };
    } else if (action === 'resume') {
      if (actor !== 'controller' && !room.members.includes(botId) && !room.team.duties.some(duty => duty.botId === botId))
        fail('Choose a current or retained member of this project', 403);
      const previous = this.manager.get(botId);
      if (previous.archivedAt || previous.maintenanceFor) fail('Resume capability owners through their catalog entry');
      const bot = await this.manager.update(botId, { status: 'active', lifecycle: { ...previous.lifecycle, state: 'active', resumedAt: now(), reason } });
      await this.manager.start(botId); result = { bot, room };
    } else if (action === 'promote') {
      if (!room.members.includes(botId)) fail('Promote a member of this room');
      const bot = await this.manager.update(botId, { lifecycle: { ...this.manager.get(botId).lifecycle, kind: 'permanent', promotedAt: now(), reason } });
      result = { bot, room };
    } else if (['leave', 'retire'].includes(action)) {
      if (!room.members.includes(botId) || [room.team.leadBotId, room.team.eggBotId, 'user'].includes(botId)) fail('Hand over the lead before removing it; EggBot remains a default member');
      let paused = [];
      if (input.stopCurrent) paused = await this.pauseWork(room, botId, operation, input.workId);
      if ((await this.works(room, botId)).some(activeWork) || this.chatroom.jobs(room.id).some(job => job.botId === botId && !terminal.has(job.status))) fail('Member still has unfinished room work; pause and confirm its actual state before leaving', 409);
      if (action === 'retire') {
        const bot = this.manager.get(botId);
        if (bot.lifecycle?.kind !== 'temporary' || bot.presetId || bot.maintenanceFor) fail('Retirement applies to temporary project members');
        if (this.store.list('rooms').some(other => other.id !== room.id && other.kind === 'group' && other.members.includes(botId))) fail('Member still belongs to another team', 409);
        if (await this.manager.readState(botId, db => (db?.listRecords('works') || []).some(activeWork))) fail('Member has unfinished work outside this room', 409);
        for (const work of await this.works(room, botId)) for (const binding of work.bindings || []) if (binding.type === 'codex-desktop') {
          const observed = await this.invoke('codex', 'read', [binding.id, {}]);
          if (!terminal.has(observed.work?.status)) fail('External work is still active or unknown; retain this member until reconciled', 409);
        }
        await this.manager.update(botId, { status: 'paused', lifecycle: { ...bot.lifecycle, state: 'dormant', retiredAt: now(), reason } });
        await this.manager.stop(botId);
      }
      room = this.change(room, { members: room.members.filter(id => id !== botId), team: { duties: room.team.duties.map(duty =>
        duty.botId !== botId || duty.state === 'closed' ? duty : { ...duty, state: 'closed', closedAt: now(), closeSource: operation.source }) } });
      result = { room, bot: this.manager.get(botId), paused, historyRetained: true };
    } else if (action === 'handoff') {
      if (!room.members.includes(botId) || [room.team.eggBotId, 'user'].includes(botId) || this.manager.get(botId).status !== 'active') fail('Choose an available current member as lead');
      const previousBotId = operation.fromBotId;
      if (botId === previousBotId) fail('Choose a different lead');
      if (![previousBotId, botId].includes(room.team.leadBotId)) fail('Another handoff changed the lead; inspect current project state', 409);
      const paused = input.stopCurrent ? await this.pauseWork(room, previousBotId, operation, input.workId) : [];
      if (stoppingPending(paused)) {
        const changed = paused.some(result => result.external?.some(item => item.status === 'changed_turn'));
        const pending = { fromBotId: previousBotId, toBotId: botId, reason, source: operation.source, at: now(), paused, status: changed ? 'needs_review' : 'waiting_for_stop', operationId };
        room = this.change(room, { team: { handoff: pending } });
        this.store.save('team-operations', { id: key, status: changed ? 'blocked' : 'waiting', retryAt: Date.now() + 5000 });
        return { room, pending: true, ...pending };
      }
      await this.manager.start(botId);
      room = this.change(room, { team: { leadBotId: botId, handoff: { fromBotId: previousBotId, toBotId: botId, reason, source: operation.source, at: now(), paused, status: 'completed', operationId } } });
      const message = await this.chatroom.post(room.id, { clientId: `team-handoff:${key}`, toBotId: botId, kind: 'event', purpose: 'request',
        content: `你接替 ${previousBotId} 承担本项目主控责任。原因：${reason}\n用 chatroom_team_read 和 chatroom_read 读取原目标、问题与交接；原 work 和外部绑定仍属原成员。先检查实际停止/未知结果，不能复制或重发已有外部工作。`, sourceRefs: operation.source ? [operation.source] : [] }, 'system');
      result = { room, fromBotId: previousBotId, toBotId: botId, paused, messageId: message.id };
    } else if (action === 'project') {
      const patch = pick(input, ['requirements', 'deadlineAt', 'nextReviewAt', 'reviewIntervalSeconds', 'auditIntervalSeconds']);
      if (input.status !== undefined) { if (!['idle', 'active', 'paused', 'completed'].includes(input.status)) fail('Invalid project state'); patch.state = input.status; }
      for (const name of ['deadlineAt', 'nextReviewAt']) if (patch[name] !== undefined && patch[name] !== null && !Number.isFinite(Date.parse(patch[name]))) fail(`Invalid ${name}`);
      for (const name of ['reviewIntervalSeconds', 'auditIntervalSeconds']) if (patch[name] !== undefined && (!Number.isFinite(patch[name]) || patch[name] < 60)) fail(`${name} must be at least 60 seconds`);
      const startsReview = room.team.state !== 'active' && (input.status === 'active' || input.status === undefined &&
        input.goal !== undefined && room.team.state === 'idle' && room.projectMode !== 'chat');
      const mode = input.status === 'idle' ? 'chat' : startsReview || input.status === 'active' ? 'project' : room.projectMode;
      if (patch.state === 'completed') patch.duties = room.team.duties.map(duty => duty.state === 'closed' ? duty :
        { ...duty, state: 'closed', closedAt: now(), closeSource: operation.source });
      room = this.change(room, { ...(input.goal !== undefined ? { goal: required(input.goal, 'goal') } : {}), projectMode: mode,
        team: { ...(startsReview ? this.startReview(room, patch.reviewIntervalSeconds) : {}), ...patch } });
      result = { room };
    } else if (action === 'resolve') {
      if (issue?.roomId !== room.id) fail('Unknown room issue', 404);
      result = { issue: this.store.save('team-issues', { id: issue.id, status: 'resolved', resolution: reason, resolvedBy: actor, resolvedAt: now() }) };
    } else fail('Unknown team action');
    this.store.save('team-history', { id: key, roomId: room.id, actor, action, botId, reason, source: operation.source,
      ...(dutyKey ? { dutyKey } : {}), ...(staffing ? { staffingDeliveryId: taskSource.input?.metadata?.deliveryId } : {}),
      ...(plannedDuty ? { assessmentId: plannedDuty.assessmentId } : {}) });
    const member = botId && this.manager.store.get('bots', botId)?.name;
    const label = action === 'close-duty' ? '已结清职责：' + (row?.name || dutyKey) :
      row ? member + ' 承接「' + row.name + '」' : '团队调整（' + action + '）';
    const message = this.chatroom.append(room.id, { clientId: `team-result:${key}`, kind: 'event', eventType: 'team_result',
      purpose: 'fyi', content: label + '：' + reason, sourceRefs: dutyRefs }, 'system');
    result = { ...result, operationId, eventMessageId: message.id };
    this.store.save('team-operations', { id: key, status: 'completed', result }); return result;
  }
  async reviewDue() {
    this.staffing.upgrade();
    for (const operation of this.store.list('team-operations').filter(operation => operation.status === 'waiting' && operation.retryAt <= Date.now())) {
      const room = this.room(operation.roomId, 'controller');
      if (room.team.state === 'paused' || room.team.state === 'completed' || this.manager.get(room.team.eggBotId).status !== 'active') continue;
      try { await this.manage(JSON.parse(operation.input), operation.actor); }
      catch (error) {
        const needsReview = error.status >= 400 && error.status < 500;
        this.store.save('team-operations', { id: operation.id, status: needsReview ? 'blocked' : 'waiting', retryAt: Date.now() + 30000, error: error.message });
        if (needsReview) await this.chatroom.post(room.id, { clientId: `handoff-review:${operation.id}`, toBotId: room.team.eggBotId, kind: 'event', purpose: 'request', content: `主控交接需要重新判断：${error.message}\n原操作：${operation.id}。请读取当前工作与用户最新要求，不能自动重放停止。` }, 'system');
      }
    }
    for (const group of this.store.list('rooms').filter(room => room.kind === 'group' && room.team)) {
      const room = await this.includeProject(group);
      await this.chatroom.dutyActions.advance(room);
      if (this.staffing.schedule(room)) continue;
      const jobs = this.staffingRoom(room) || room.team.state === 'active' ? this.chatroom.jobs(room.id) : [];
      if (this.queueStaffing(room, jobs)) continue;
      if (room.team.state !== 'active') continue;
      const team = room.team, bot = this.manager.get(team.eggBotId);
      if (bot.status !== 'active' || bot.runIntent === 'stopped' || jobs.some(job => (job.teamReview || job.teamStaffing) && !terminal.has(job.status))) continue;
      const time = Date.now(), due = team.nextReviewAt ? Date.parse(team.nextReviewAt) : Date.parse(team.lastReviewAt || room.createdAt) + team.reviewIntervalSeconds * 1000;
      const deadlineDue = team.deadlineAt && Date.parse(team.deadlineAt) <= time && team.reviewedDeadline !== team.deadlineAt;
      if (!deadlineDue && due > time) continue;
      const latest = this.chatroom.latestProjectMessage(room.id);
      const changed = latest && latest.id !== (team.reviewFromMessageId || team.lastReviewMessageId);
      if (!changed && !deadlineDue) continue;
      const audit = time - Date.parse(team.lastAuditAt || room.createdAt) >= team.auditIntervalSeconds * 1000;
      const message = this.chatroom.append(room.id, { clientId: `team-review:${room.id}:${team.revision}:${due}`, kind: 'event', purpose: 'request', toBotId: team.eggBotId,
        content: `项目协作复核。目标：${room.goal}\n期限：${team.deadlineAt || '未指定'}。${deadlineDue ? '期限已到，需要按原要求处理剩余工作。' : ''}\n从 chatroom_team_read 和必要原文检查：真正交付缺口是否减少，现有分工与依赖是否仍合理，是否需要同伴讨论、补充方法、邀请/孵化成员或交接。活动、日志增长和进程存活不等于进展，不按时间直接杀任务。${audit ? '本次同时检查反复用户纠正与定时职责的实际价值/调用浪费。' : ''}没有新贡献返回 PASS，不复述进度，不为反思制造工作。` }, 'system');
      this.chatroom.enqueue(message, team.eggBotId, { teamReview: true, priority: 'background' });
      this.change(room, { team: { lastReviewAt: now(), nextReviewAt: new Date(time + team.reviewIntervalSeconds * 1000).toISOString(), lastReviewMessageId: latest?.id || null, reviewFromMessageId: null,
        ...(deadlineDue ? { reviewedDeadline: team.deadlineAt } : {}), ...(audit ? { lastAuditAt: now() } : {}) } });
    }
  }
}
