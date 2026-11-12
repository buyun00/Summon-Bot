import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, required, pick, now } from '../shared/validation.mjs';
import { activeDuties, Staffing, staffingArtifacts, staffingPolicyVersion, staffingProject, staffingScope, staffingSnapshot } from './staffing.mjs';
import { externalExecution } from '../../bot/src/context/execution-evidence.mjs';
import { ROOM_DUTY_PLANS } from '../../bot/src/context/duty-actions.mjs';
import { workflowReviewerId } from '../../bot/src/context/workflow-review.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const activeWork = work => ['active', 'waiting', 'blocked'].includes(work.status);
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const stoppingPending = results => results.some(result => result.taskId && !terminal.has(result.status) || result.external?.some(item => !terminal.has(item.status)));
const dutyActions = new Set(['create', 'invite', 'assign']);
const staffingActions = new Set([...dutyActions, 'close-duty']);
const staffingBatchSize = 8;
const staffingInstruction = [
  '先读 chatroom_team_read、bots_list 和必要的本群原文。从项目实际行业、规模、目标、阶段产物和已定后续发现职责，包括尚无独立 WORK 的职责。实际有收益时可在范围讨论首轮提议组队。普通闲聊或未选定的点子用 ordinary 或 unclear，候选留空。',
  '为项目及 staffing.reviewWorks 中的每项按「行不行、好不好、怎么更好」提交 comparison。核实际能力、上下文与授权，再核持续交付、专业判断、记忆维护、独立验证及并行。最后比较具体安排的收益、交接成本和选择。保留现状也写实际比较；无可行替代时给事实和限制。',
  '候选给出对象、边界、产出、参与时机和续用材料。可沿原人、收窄范围、复用同伴或独立 work。沿用既有 dutyKey，真实范围调整用 dutyChange=adjust，交接用 dutyChange=handoff。保留原 WORK、执行和授权。',
  '用 chatroom_team_manage action=assess 保存判断。引用快照或本群读取返回的完整消息 ID。服务仅在实际需要时询问一次，收到原群用户选择后才沿权限落实。制作方自测、实际发布和用户验收各按原授权处理。',
].join('\n');

export function groupTeam(members, manager, input = {}) {
  const eggBotId = 'bot-eggbot';
  manager.get(eggBotId);
  const leadBotId = input.leadBotId || members.find(id => !['user', eggBotId, workflowReviewerId].includes(id) && manager.get(id).status === 'active') || 'bot-entry';
  if ([eggBotId, workflowReviewerId].includes(leadBotId) || manager.get(leadBotId).status !== 'active') fail('Choose an available project lead');
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
  async staffingWorks(room, evidence) {
    const relevant = new Set(evidence.map(signal => signal.workId).filter(Boolean));
    const roomUserSource = source => {
      if (source?.roomId !== room.id || source.actor !== 'user' || !source.replyTo) return false;
      const message = this.store.get('messages', source.replyTo);
      return message?.roomId === room.id && message.senderId === 'user';
    };
    const report = (text, limit) => typeof text === 'string' ? text.slice(0, limit) : undefined;
    const memberIds = room.members.filter(id => !['user', room.team.eggBotId, workflowReviewerId].includes(id));
    const publications = new Map();
    for (const message of this.chatroom.messages(room.id)) if (this.chatroom.staffingEvidence(message)?.kind === 'work-result') {
      const list = publications.get(message.workId) || [];
      publications.set(message.workId, [...list.slice(-1), message]);
    }
    const members = await Promise.all(memberIds.map(botId => this.manager.readState(botId, db => {
      if (!db) return [];
      const works = db.listRecords('works').filter(work => work.sources?.some(roomUserSource));
      const selected = new Set([...works.filter(work => relevant.has(work.id)),
        ...works.filter(activeWork).slice(-6), ...works.slice(-1)]);
      const selectedIds = new Set([...selected].map(work => work.id));
      const accepted = db.listRecords('work-events').filter(event => selectedIds.has(event.workId) &&
        event.kind === 'request' && event.receipt?.accepted && roomUserSource(event.authorization?.source));
      return [...selected].map(work => {
        const sameRoom = work.sources.every(source => source.roomId === room.id);
        const sourceMessageIds = [...new Set(work.sources.filter(roomUserSource).map(source => source.replyTo))].slice(-6);
        const operations = accepted.filter(event => event.workId === work.id).slice(-2);
        const native = sameRoom && work.bindings?.some(binding => ['native-tool','native-recovery','native-api'].includes(binding.type)) &&
          externalExecution(work);
        const acceptedScope = operations.map(event => ({
          operationId: event.id, messageId: event.authorization.source.replyTo, stage: event.authorization.production?.stage,
          scope: report(event.authorization.production?.scope, 1000),
          ...(sameRoom ? { handoff: report(event.content?.handoff?.instruction || event.content?.handoff?.goal, 600) } : {}),
        }));
        const published = (publications.get(work.id) || []).filter(message => message.senderId === botId)
          .map(message => ({ messageId: message.id, replyTo: message.replyTo, at: message.createdAt,
            attachments: staffingArtifacts(message).slice(0, 8).map(file => file.name) }));
        const acceptance = work.acceptance;
        const acceptanceMessageId = roomUserSource({ ...acceptance?.source, actor: acceptance?.source?.userId,
          replyTo: acceptance?.source?.messageId }) && acceptance.source.messageId;
        const savedAcceptance = acceptanceMessageId ? { messageId: acceptanceMessageId, fullScope: acceptance.fullScope === true,
          publicationMessageIds: (acceptance.publicationMessageIds || []).filter(id => this.store.get('messages', id)?.roomId === room.id),
          recordedAt: acceptance.recordedAt } : null;
        return { ...pick(work, ['id', 'productionStage', 'status', 'updatedAt']), botId, sourceMessageIds, acceptedScope,
          published, savedAcceptance,
          ...(sameRoom ? { goal: report(work.goal, 600), requirements: report(work.requirements, 1000),
            responsibility: report(work.responsibility, 500), progress: report(work.progress, 1000),
            next: report(work.checkpoint?.next, 400), waiting: pick(work.waiting || {}, ['kind', 'reason', 'operationId']),
            lastError: work.lastError && { kind: work.lastError.kind, message: report(work.lastError.message || work.lastError.error?.message, 400) } } : {}),
          ...(native ? { execution: { ...pick(native, ['operationId', 'turnId', 'currentOperation', 'externalReceived',
            'startedConfirmed', 'status', 'transportStatus']),
            observedAt: native.observation?.observedAt } } : {}) };
      });
    })));
    return members.flat();
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
  confirmStaffingSource(room, messageId) {
    const state = this.store.get('team-staffing', room.id);
    if (!state?.pending?.some(signal => signal.messageId === messageId && signal.provisional)) return;
    const latest = this.chatroom.position(room.id, state.latestUserMessageId), current = this.chatroom.position(room.id, messageId);
    const newer = current && (!latest || current.at > latest.at || current.at === latest.at && current.row > latest.row);
    const pending = state.pending.map(signal => signal.messageId === messageId && signal.provisional ? { ...signal, provisional: false } : signal);
    this.store.save('team-staffing', { id: room.id, pending, ...(newer ? { latestUserMessageId: messageId } : {}) });
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
    const latestUserMessageId = signals.findLast(signal => signal.kind === 'user-update' && !signal.provisional)?.messageId || state?.latestUserMessageId || null;
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
    if (state?.readyAt > Date.now() || state?.pending?.some(signal => signal.provisional) || !baseline && !state?.pending?.length) return false;
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
    const matches = binding => binding.workId === message.workId && binding.botId === message.senderId &&
      binding.sourceMessageId === message.replyTo && artifacts.some(artifact => artifact.operationId === binding.operationId);
    const linked = (room.team.duties || []).filter(duty => duty.workBindings?.some(matches));
    if (linked.length) this.addDutyEvidence(room, linked, [message], [], artifacts);
    const current = this.chatroom.need('rooms', room.id);
    const former = current.team.duties.filter(duty => duty.formerAssignments?.some(assignment => assignment.workBindings.some(matches)));
    if (former.length) this.change(current, { team: { duties: current.team.duties.map(duty => !former.includes(duty) ? duty : {
      ...duty, referenceArtifacts: [...new Map([...(duty.referenceArtifacts || []), ...artifacts].map(item => [item.id, item])).values()],
    }) } }, current.team.revision);
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
    const job = staffing && this.store.get('deliveries', source.input?.metadata?.deliveryId);
    const initialWorks = job?.input?.content?.staffing?.reviewWorks || [];
    const currentWorks = initialWorks.length ? await this.staffingWorks(room, initialWorks.map(work => ({ workId: work.id }))) : [];
    const reviewWorks = initialWorks.map(work => currentWorks.find(current => current.id === work.id && current.botId === work.botId) || work);
    const members = await Promise.all(room.members.filter(id => id !== 'user').map(async id => {
      const bot = this.manager.get(id), works = await this.works(room, id);
      return { ...pick(bot, ['id', 'name', 'roleId', 'role', 'expertise', 'status', 'runIntent', 'firstRunPending', 'lifecycle', 'skills']),
        ...(staffing ? { activeRoomWorkCount: works.filter(activeWork).length, allowedTools: bot.allowedTools || [] } : {}),
        works: staffing ? reviewWorks.filter(work => work.botId === id) : works.map(work => ({
          ...pick(work, ['id', 'goal', 'progress', 'responsibility', 'productionStage', 'status', 'waiting', 'lastError', 'updatedAt']),
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
      const assessment = this.staffing.forDelivery(job);
      return { room: pick(room, ['id', 'name', 'goal', 'status', 'members', 'projectMode', 'team']), members, availableRoles: roles, pendingDuties,
        dutyActions: this.chatroom.dutyActions.view(room.id),
        issues: issues.filter(issue => issue.status === 'open'),
        staffing: { reviewWorks, recentEvidence: staffingSnapshot(this.chatroom, room),
          proposals: this.staffing.proposalHistory(room),
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
    this.store.save('team-operations', { id: operation.id, stoppingWorkIds: operation.stoppingWorkIds });
    const jobs = this.chatroom.jobs(room.id).filter(job => job.botId === botId && !terminal.has(job.status) && (!workId || job.workId === workId));
    const paused = await this.manager.pauseProject(botId, { roomId: room.id, workIds: operation.stoppingWorkIds, taskIds: jobs.map(job => job.taskId).filter(Boolean), messageIds: jobs.map(job => job.id) });
    const results = [...paused.tasks];
    for (const work of works) {
      const saved = await this.manager.readState(botId, db => db?.getRecord('works', work.id));
      const external = (saved?.bindings || []).filter(binding => ['native-tool', 'native-recovery'].includes(binding.type)).map(binding => ({
        bindingId: binding.id, operationId: binding.operationId, nativeSessionId: binding.nativeSessionId,
        status: ['stopped', 'superseded', 'historical', 'unavailable', 'resumable'].includes(binding.status) ? 'interrupted' : binding.status,
      }));
      results.push({ workId: work.id, status: saved?.status || 'unknown', external });
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
    const row = plannedDuty?.row;
    const transferring = row?.dutyChange === 'handoff';
    const suppliedKey = input.dutyKey === undefined ? null : required(input.dutyKey, 'dutyKey', 80).toLowerCase();
    const dutyKey = suppliedKey || operation?.dutyKey || (dutyActions.has(action) ?
      room.team.duties.find(duty => duty.botId === input.botId && duty.state !== 'closed' && !duty.dutyProfile)?.dutyKey || 'duty.' + randomUUID() : null);
    if (dutyKey && !/^[a-z0-9][a-z0-9._-]*$/.test(dutyKey)) fail('Choose a stable duty key made of letters, digits, dots, hyphens or underscores');
    if (!plannedDuty && actor !== 'controller' && this.staffingRoom(room) && (staffingActions.has(action) || action === 'handoff'))
      fail('Use this room’s staffing assessment and the user’s group choice for duty changes. Lead handoff is a separate team management action.', 403);
    const checkStaffing = current => {
      if (!staffing) return;
      const message = input.sourceMessageId && this.store.get('messages', input.sourceMessageId);
      const egg = this.manager.get(actor);
      if (actor !== current.team.eggBotId || taskSource.roomId !== current.id || !this.staffingRoom(current) ||
          egg.status !== 'active' || egg.runIntent !== 'running' ||
          !plannedDuty || !staffingActions.has(action) || !Number.isSafeInteger(input.expectedRevision) ||
          message?.roomId !== current.id || message.senderId !== 'user' || message.id !== row.choice?.messageId ||
          !this.staffing.isChoice(message.id) || !suppliedKey)
        fail('Staffing needs the current room and an authenticated user choice', 403);
      if (JSON.stringify(staffingScope(current)) !== JSON.stringify(plannedDuty.scope))
        fail('The assessed project scope is no longer current', 409);
      const duty = current.team.duties.find(item => item.dutyKey === dutyKey);
      if (duty?.operationId !== operationId &&
          ((duty?.botId || null) !== row.previousOwnerId || (duty?.operationId || null) !== row.previousAssignmentId))
        fail('职责已由其他操作变更，原选择未应用。', 409);
      if ((row.dutyChange || action === 'close-duty') && this.store.list(ROOM_DUTY_PLANS).some(plan =>
          plan.roomId === current.id && plan.dutyKey === dutyKey && plan.ownerBotId === row.previousOwnerId &&
          ['waiting', 'queued'].includes(plan.status)))
        fail('该职责还有原请求绑定的交接或复核在途。', 409);
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
        if (bot.id === workflowReviewerId || action === 'assign' && (!room.members.includes(bot.id) || bot.status !== 'active')) fail('Choose a current available member', 409);
      }
      if (dutyActions.has(action) && dutyKey && (!transferring && room.team.duties.some(duty => duty.dutyKey === dutyKey && duty.botId !== input.botId) ||
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
    const dutyRefs = row ? [...row.sourceRefs, operation.source] : operation.source ? [operation.source] : [];
    const handoff = row?.outcome ? ['交付：' + row.outcome, '完成条件：' + row.acceptance,
      '参与时机：' + row.participation, '续用材料：' + row.retainedContext].join('\n') : '';
    const placeDuty = (members, responsibility, state = 'active') => {
      const previous = room.team.duties.find(item => item.dutyKey === dutyKey);
      const replacing = previous?.botId && previous.botId !== botId;
      if (replacing && (!transferring || previous.botId !== row.previousOwnerId || previous.operationId !== row.previousAssignmentId))
        fail('This responsibility already has another owner', 409);
      if (previous?.operationId === operationId && previous.state === state) return room;
      const evidence = plannedDuty && this.staffing.dutyEvidence(previous, row);
      const duty = { ...previous, botId, dutyKey, responsibility, state, source: operation.source, operationId,
        ...(state === 'active' ? { assignedAt: now(), closedAt: null } : {}),
        ...(plannedDuty ? { assessmentId: plannedDuty.assessmentId, ...evidence } : {}),
        ...(replacing ? { workIds: [], workBindings: [], artifacts: [],
          referenceWorkIds: [...new Set([...evidence.referenceWorkIds, ...(previous.workIds || [])])],
          referenceArtifacts: [...new Map([...evidence.referenceArtifacts, ...(previous.artifacts || [])]
            .map(item => [item.id, item])).values()],
          formerAssignments: [...(previous.formerAssignments || []), { botId: previous.botId, operationId: previous.operationId,
            workBindings: previous.workBindings || [] }] } : {}) };
      return this.change(room, { ...(members ? { members } : {}),
        team: { duties: [...room.team.duties.filter(item => item.dutyKey !== dutyKey), duty] } });
    };
    if (['invite', 'create'].includes(action)) {
      const responsibility = required(input.responsibility, 'responsibility', 4000);
      if (action === 'create') {
        if (plannedDuty && !activeDuties(room, botId).some(duty => duty.dutyKey === dutyKey && duty.operationId === operationId))
          room = placeDuty(null, responsibility, 'provisioning');
        const prompt = required(input.prompt, 'prompt', 16000);
        await this.manager.create({ id: botId, workspaceProfileId: room.workspaceProfileId, name: required(input.name, 'name', 100), roleId: input.roleId || 'default', prompt,
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
        for (const work of await this.works(room, botId)) if (work.bindings?.some(binding =>
          ['native-tool', 'native-recovery'].includes(binding.type) && !terminal.has(binding.status) &&
          !['stopped', 'superseded', 'historical', 'unavailable', 'resumable'].includes(binding.status)))
          fail('An original native operation is still active or unknown', 409);
        await this.manager.update(botId, { status: 'paused', lifecycle: { ...bot.lifecycle, state: 'dormant', retiredAt: now(), reason } });
        await this.manager.stop(botId);
      }
      room = this.change(room, { members: room.members.filter(id => id !== botId), team: { duties: room.team.duties.map(duty =>
        duty.botId !== botId || duty.state === 'closed' ? duty : { ...duty, state: 'closed', closedAt: now(), closeSource: operation.source }) } });
      result = { room, bot: this.manager.get(botId), paused, historyRetained: true };
    } else if (action === 'handoff') {
      if (!room.members.includes(botId) || [room.team.eggBotId, 'user', workflowReviewerId].includes(botId) || this.manager.get(botId).status !== 'active') fail('Choose an available current member as lead');
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
      transferring ? '「' + row.name + '」已交接给 ' + member + '。既有工作由原承接者继续。' :
      row ? member + ' 承接「' + row.name + '」' : '团队调整（' + action + '）';
    const message = this.chatroom.append(room.id, { clientId: `team-result:${key}`, kind: 'event', eventType: 'team_result',
      purpose: 'fyi', content: label + '：' + reason, sourceRefs: dutyRefs }, 'system');
    result = { ...result, operationId, eventMessageId: message.id };
    this.store.transaction(() => {
      this.store.save('team-operations', { id: key, status: 'completed', result });
      if (action === 'handoff' || row?.dutyChange) this.noteStaffing(room, [{ key: 'handoff:' + key,
        kind: 'team-handoff', messageId: message.id, ownerBotId: botId, workId: input.workId || null }]);
    });
    return result;
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
      await this.chatroom.roomTextResults.reconcile(group).catch(error =>
        this.chatroom.emit('room-acceptance-projection-error', { roomId: group.id, error: error.message }));
      const room = await this.includeProject(this.chatroom.need('rooms', group.id));
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
        content: `项目协作复核。目标：${room.goal}\n期限：${team.deadlineAt || '未指定'}。${deadlineDue ? '期限已到，需要按原要求处理剩余工作。' : ''}\n从 chatroom_team_read 和必要原文对照当前需求、实际承接范围、成员职责和能力、真实进展及产物，说明保留分工的依据或需调整的具体责任。遇到需求变化、交接、阶段产物和反复卡点时复核覆盖情况。成员调整沿团队分工选择，原工作沿原执行者和授权继续。${audit ? '本次同时检查反复用户纠正与定时职责的实际价值。' : ''}没有新贡献返回 PASS。` }, 'system');
      this.chatroom.enqueue(message, team.eggBotId, { teamReview: true, priority: 'background' });
      this.change(room, { team: { lastReviewAt: now(), nextReviewAt: new Date(time + team.reviewIntervalSeconds * 1000).toISOString(), lastReviewMessageId: latest?.id || null, reviewFromMessageId: null,
        ...(deadlineDue ? { reviewedDeadline: team.deadlineAt } : {}), ...(audit ? { lastAuditAt: now() } : {}) } });
    }
  }
}
