import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, required, pick, now } from '../shared/validation.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const activeWork = work => ['active', 'waiting', 'blocked'].includes(work.status);
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const stoppingPending = results => results.some(result => result.taskId && !terminal.has(result.status) || result.external?.some(item => !terminal.has(item.status)));

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
  constructor(chatroom, { invoke } = {}) { this.chatroom = chatroom; this.invoke = invoke; this.projectEvidenceChecked = new Map(); }
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
  async read(input, actor) {
    const room = this.room(input.roomId, actor);
    const members = await Promise.all(room.members.filter(id => id !== 'user').map(async id => {
      const bot = this.manager.get(id), works = await this.works(room, id);
      return { ...pick(bot, ['id', 'name', 'roleId', 'role', 'expertise', 'status', 'runIntent', 'lifecycle', 'skills']),
        works: works.map(work => pick(work, ['id', 'goal', 'progress', 'responsibility', 'status', 'waiting', 'lastError', 'updatedAt'])) };
    }));
    const entries = await readdir(join(this.manager.releaseRoot, 'roles'), { withFileTypes: true });
    const roles = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const role = JSON.parse(await readFile(join(this.manager.releaseRoot, 'roles', entry.name, 'role.json'), 'utf8'));
      return pick(role, ['id', 'name', 'role', 'skills', 'tools']);
    }));
    const messages = this.chatroom.messages(room.id), jobs = this.chatroom.jobs(room.id);
    const usage = messages.reduce((total, message) => total + Number(message.usage?.totalTokens || message.usage?.total || 0), 0);
    return { room: pick(room, ['id', 'name', 'goal', 'status', 'team']), members, availableRoles: roles,
      issues: this.store.list('team-issues').filter(issue => issue.roomId === room.id).slice(-40),
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
    const posted = await this.chatroom.post(room.id, { clientId: `team-issue:${id}`, toBotId: issue.targetBotId, purpose: 'request', kind: 'event',
      content: `团队协作问题：${title}\n${message}\n请从原目标和当前职责判断，查证后处理；不要仅转述或默认新增 Bot。问题ID：${id}`,
      sourceRefs: source ? [source] : [] }, actor === 'controller' ? 'user' : actor);
    this.store.save('team-issues', { id, messageId: posted.id });
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
  async manage(input, actor) {
    let room = this.room(input.roomId, actor);
    const action = required(input.action, 'action', 40), reason = required(input.reason, 'reason', 3000);
    const coordinator = actor === 'controller' || actor === room.team.eggBotId;
    if (!coordinator && !(actor === room.team.leadBotId && ['project', 'assign', 'resolve'].includes(action))) fail('Ask this room’s EggBot to manage its members', 403);
    const operationId = required(input.operationId, 'operationId', 128), key = JSON.stringify([room.id, actor, operationId]);
    let operation = this.store.get('team-operations', key);
    if (operation && operation.input !== canonical(input)) fail('operationId belongs to another team action', 409);
    if (operation?.result) return operation.result;
    if (!operation) {
      if (input.expectedRevision !== undefined && input.expectedRevision !== room.team.revision) fail('Team changed; read current state', 409);
      operation = this.store.save('team-operations', { id: key, action, actor, roomId: room.id, input: canonical(input), source: this.source(room, input.sourceMessageId),
        fromBotId: room.team.leadBotId, botId: input.botId || (action === 'create' ? `bot-${randomUUID()}` : null), status: 'pending' });
    }
    let result;
    const botId = operation.botId;
    if (['invite', 'create'].includes(action)) {
      const responsibility = required(input.responsibility, 'responsibility', 4000);
      if (action === 'create') {
        const prompt = required(input.prompt, 'prompt', 16000);
        await this.manager.create({ id: botId, name: required(input.name, 'name', 100), roleId: input.roleId || 'default', prompt,
          cwd: input.cwd, lifecycle: { kind: 'temporary', state: 'active', originRoomId: room.id, createdBy: actor, reason } });
      }
      const bot = this.manager.get(botId);
      if (bot.status !== 'active' || bot.archivedAt || bot.lifecycle?.state === 'dormant') fail('Member is paused or retired; do not silently resume it', 409);
      await this.manager.start(botId);
      room = this.change(room, { members: [...new Set([...room.members, botId])], team: { duties: [...room.team.duties.filter(duty => duty.botId !== botId), { botId, responsibility, assignedAt: now(), source: operation.source }] } });
      const message = await this.chatroom.post(room.id, { clientId: `team-join:${key}`, toBotId: botId, kind: 'event', purpose: 'request',
        content: `你加入此项目并承接：${responsibility}\n项目目标：${room.goal}\n要求：${room.team.requirements}\n先用 chatroom_team_read 读取当前团队，按来源和已有授权推进；持续任务建立自己的 work，保留来源 roomId=${room.id}。`,
        sourceRefs: operation.source ? [operation.source] : [] }, 'system');
      result = { bot: this.manager.get(botId), room, messageId: message.id, responsibility };
    } else if (action === 'assign') {
      if (!room.members.includes(botId) || botId === 'user') fail('Choose a current member');
      const responsibility = required(input.responsibility, 'responsibility', 4000);
      room = this.change(room, { team: { duties: [...room.team.duties.filter(duty => duty.botId !== botId), { botId, responsibility, assignedAt: now(), source: operation.source }] } });
      const message = await this.chatroom.post(room.id, { clientId: `team-assign:${key}`, toBotId: botId, purpose: 'request', kind: 'event', content: `项目责任调整：${responsibility}\n依据：${reason}。沿已有工作继续，先查当前团队与原始要求。`, sourceRefs: operation.source ? [operation.source] : [] }, 'system');
      result = { room, messageId: message.id };
    } else if (action === 'resume') {
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
      room = this.change(room, { members: room.members.filter(id => id !== botId), team: { duties: room.team.duties.filter(duty => duty.botId !== botId) } });
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
      room = this.change(room, { ...(input.goal !== undefined ? { goal: required(input.goal, 'goal') } : {}), projectMode: mode,
        team: { ...(startsReview ? this.startReview(room, patch.reviewIntervalSeconds) : {}), ...patch } });
      result = { room };
    } else if (action === 'resolve') {
      const issue = this.store.get('team-issues', input.issueId);
      if (issue?.roomId !== room.id) fail('Unknown room issue', 404);
      result = { issue: this.store.save('team-issues', { id: issue.id, status: 'resolved', resolution: reason, resolvedBy: actor, resolvedAt: now() }) };
    } else fail('Unknown team action');
    this.store.save('team-history', { id: key, roomId: room.id, actor, action, botId, reason, source: operation.source });
    const message = this.chatroom.append(room.id, { clientId: `team-result:${key}`, kind: 'event', purpose: 'fyi', content: `团队调整（${action}）：${reason}`, sourceRefs: operation.source ? [operation.source] : [] }, 'system');
    result = { ...result, operationId, eventMessageId: message.id };
    this.store.save('team-operations', { id: key, status: 'completed', result }); return result;
  }
  async reviewDue() {
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
      if (room.team.state !== 'active') continue;
      const team = room.team, bot = this.manager.get(team.eggBotId), jobs = this.chatroom.jobs(room.id);
      if (bot.status !== 'active' || bot.runIntent === 'stopped' || jobs.some(job => job.teamReview && !terminal.has(job.status))) continue;
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
