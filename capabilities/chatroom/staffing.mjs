import { randomUUID } from 'node:crypto';
import { fail, now, pick, required } from '../shared/validation.mjs';

export const staffingCoverageVersion = 1;
export const staffingAreas = [
  { area: 'design', roles: [{ id: 'designer', name: '设计策划' }, { id: 'game-designer', name: '玩法策划' }],
    focus: '实际领域的设计规则、交互及验收判据' },
  { area: 'visuals', roles: [{ id: 'visual-designer', name: '视觉设计' }, { id: 'game-artist', name: '项目美术' }],
    focus: '实际领域的视觉素材、提示和可读性' },
  { area: 'implementation', roles: [{ id: 'engineer', name: '项目程序' }], focus: '已明确的程序实现、接口和实际交付边界' },
  { area: 'verification', roles: [{ id: 'qa', name: '独立验证' }], focus: '与制作方分开的实物或正式入口验证及证据边界' },
  { area: 'maintenance', roles: [{ id: 'components', name: '组件维护' }], focus: '共享组件、变更影响和下游回归责任' },
];
const assessments = 'team-staffing-assessments';
const staffState = 'team-staffing';
const decided = new Set(['needed', 'not-needed', 'deferred']);
const handling = new Set(['specialist', 'independent-work', 'project-knowledge', 'current-work', 'deferred']);
const taskQuestions = ['input', 'output', 'done', 'independence', 'knowledge', 'maintenance', 'capacity', 'availableOwner'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const dutyKey = area => `staffing.${area}`;
const operationKey = (plan, row) => JSON.stringify([plan.roomId, plan.actor, row.operationId]);
const roomRef = message => ({ type: 'room-message', roomId: message.roomId, messageId: message.id, actor: message.senderId });

export const coverageProject = room => room?.kind === 'group' && room.status === 'active' &&
  room.team?.state === 'active' && room.projectMode !== 'chat';

/** Select current scope and real deliveries, including an unsuccessful later
 * report and artifacts from earlier work. The selected messages are evidence. */
export function staffingSnapshot(chatroom, room) {
  const messages = chatroom.messages(room.id).flatMap(message => {
    const signal = chatroom.staffingEvidence(message);
    return signal ? [{ message, signal }] : [];
  });
  const selected = new Set();
  for (const { message } of messages.filter(({ signal }) => signal.kind === 'user-update').slice(-5)) selected.add(message.id);
  const reports = messages.filter(({ signal }) => signal.kind === 'work-result');
  const delivered = new Set();
  for (const { message } of [...reports].reverse()) {
    if (!message.attachments?.length || delivered.has(message.workId)) continue;
    selected.add(message.id);
    delivered.add(message.workId);
    if (delivered.size === 5) break;
  }
  for (const { message } of reports.slice(-3)) selected.add(message.id);
  const parents = messages.filter(({ message }) => selected.has(message.id) && message.replyTo)
    .map(({ message }) => message.replyTo);
  for (const id of parents.slice(-3)) selected.add(id);
  return messages.filter(({ message }) => selected.has(message.id)).map(({ signal }) => signal);
}

export class StaffingCoverage {
  constructor(team) { this.team = team; this.running = new Map(); }
  get chatroom() { return this.team.chatroom; }
  get store() { return this.team.store; }
  get manager() { return this.team.manager; }
  get(id) { return this.store.get(assessments, id); }

  view(plan) {
    return { assessmentId: plan.id, status: plan.status, assessedRevision: plan.assessedRevision,
      noChange: plan.status === 'completed' && !plan.areas.some(row => row.state === 'assigned'),
      areas: plan.areas.map(row => pick(row, ['area', 'roleId', 'dutyKey', 'decision', 'reason', 'state', 'botId', 'operationId', 'sourceRefs', 'receipt', 'error'])) };
  }

  assess(input, actor, source) {
    const room = this.team.room(input.roomId, actor);
    const deliveryId = source?.input?.metadata?.deliveryId;
    const job = deliveryId && this.store.get('deliveries', deliveryId);
    if (source?.metadata?.teamStaffing !== true || source.roomId !== room.id || actor !== room.team.eggBotId ||
        !coverageProject(room) || job?.roomId !== room.id || job.botId !== actor || terminal.has(job.status) ||
        job.teamStaffing?.coverageVersion !== staffingCoverageVersion)
      fail('A coverage assessment requires this project’s current EggBot staffing delivery', 403);

    const operationId = required(input.operationId, 'operationId', 128);
    const previous = this.get(deliveryId);
    if (previous) {
      if (previous.operationId !== operationId) fail('This delivery already has a saved assessment. Read the original result.', 409);
      return this.view(previous);
    }
    if (input.expectedRevision !== room.team.revision) fail('Team changed; read its current revision', 409);
    if (input.sourceMessageId !== job.messageId) fail('Use this staffing delivery’s triggerMessageId as the assessment source');
    if (!Array.isArray(input.coverage) || input.coverage.length !== staffingAreas.length ||
        new Set(input.coverage.map(row => row?.area)).size !== staffingAreas.length)
      fail('Assess each of the five responsibility areas once');

    const areas = staffingAreas.map(spec => {
      const row = input.coverage.find(item => item?.area === spec.area);
      if (!row || !decided.has(row.decision)) fail(`Choose a decision for ${spec.area}`);
      const reason = required(row.reason, 'reason', 900);
      if (!Array.isArray(row.sourceMessageIds) || !row.sourceMessageIds.length || row.sourceMessageIds.length > 8)
        fail(`Cite one to eight original messages for ${spec.area}`);
      const evidence = [...new Set(row.sourceMessageIds)].map(id => this.store.get('messages', id));
      if (evidence.some(message => message?.roomId !== room.id || !this.chatroom.staffingEvidence(message)))
        fail('Coverage sources must be original user messages or authenticated work results in this room', 403);
      const publications = evidence.filter(message => this.chatroom.staffingEvidence(message)?.kind === 'work-result');
      const citedIds = new Set(evidence.map(message => message.id));
      const dispatched = job.teamStaffing.evidence.filter(signal => signal.kind === 'work-dispatch' && citedIds.has(signal.messageId));
      const workIds = [...new Set([...publications, ...dispatched].map(item => item.workId))];
      const makerBotIds = [...new Set([
        ...publications.map(message => message.senderId),
        ...dispatched.map(signal => signal.ownerBotId).filter(Boolean),
      ])];
      if (!Array.isArray(row.items) || row.items.length > 4) fail(`List up to four confirmed or near-term items for ${spec.area}`);
      const items = row.items.map(item => {
        if (!item || !['confirmed', 'near-term'].includes(item.basis) || !handling.has(item.handling) ||
            !citedIds.has(item.sourceMessageId)) fail('Each item needs its scope, one of the cited sources and its proposed handling');
        return { title: required(item.title, 'title', 180), ...pick(item, ['basis', 'sourceMessageId', 'handling']),
          ...Object.fromEntries(taskQuestions.map(field => [field, required(item[field], field, 400)])) };
      });
      const dedicated = items.filter(item => item.handling === 'specialist');
      if ((row.decision === 'needed') !== Boolean(dedicated.length)) fail('Use needed exactly when an item has a concrete specialist responsibility');
      const core = { area: spec.area, decision: row.decision, reason, items, sourceRefs: evidence.map(roomRef), workIds, makerBotIds };
      if (row.decision !== 'needed') return { ...core, state: row.decision };
      const role = spec.roles.find(role => role.id === (row.roleId || (spec.roles.length === 1 && spec.roles[0].id)));
      if (!role) fail(`Choose a matching domain role for ${spec.area}`);
      if (spec.area === 'maintenance' && workIds.length < 2 &&
          !evidence.some(message => message.id === row.dependencySourceMessageId && message.senderId === 'user'))
        fail('Name the component and cite distinct actual works or an original user message defining its downstream dependency');
      return { ...core, roleId: role.id, state: 'pending', dutyKey: dutyKey(spec.area), operationId: `staffing:${randomUUID()}`,
        ...(row.dependencySourceMessageId ? { dependencySourceMessageId: row.dependencySourceMessageId } : {}),
        responsibility: required(row.responsibility, 'responsibility', 1600),
        ...(row.existingOwnerId ? { existingOwnerId: required(row.existingOwnerId, 'existingOwnerId', 128) } : {}),
        ...(row.candidateBotId ? { candidateBotId: required(row.candidateBotId, 'candidateBotId', 128) } : {}) };
    });
    const state = this.store.get(staffState, room.id);
    const activePlan = state?.activeAssessmentId && this.get(state.activeAssessmentId);
    if (activePlan?.status === 'applying') fail('Read the current staffing assessment before opening another one', 409);
    const applying = areas.some(row => row.state === 'pending');
    const plan = this.store.transaction(() => {
      const saved = this.store.save(assessments, { id: deliveryId, actor, roomId: room.id, operationId, areas,
        sourceMessageId: job.messageId, coverageVersion: staffingCoverageVersion, assessedRevision: room.team.revision,
        goal: room.goal, requirements: room.team.requirements,
        status: applying ? 'applying' : 'completed', ...(applying ? {} : { finishedAt: now() }) });
      this.store.save(staffState, { id: room.id, lastAssessmentId: deliveryId, activeAssessmentId: applying ? deliveryId : null,
        ...(job.teamStaffing.coverageBaseline ? { coverageReviewAssessmentId: deliveryId } : {}) });
      return saved;
    });
    return this.view(plan);
  }

  async available(botId, spec, row, room) {
    if (!botId || (spec.area === 'verification' && (botId === room.team.leadBotId || row.makerBotIds.includes(botId)))) return false;
    const bot = this.manager.store.get('bots', botId);
    if (bot?.roleId !== row.roleId || bot.status !== 'active' || bot.runIntent !== 'running' ||
        bot.archivedAt || bot.maintenanceFor || bot.lifecycle?.state === 'dormant' ||
        !['chatroom_read', 'chatroom_team_read'].every(name => bot.allowedTools?.includes(name))) return false;
    return (await this.manager.identity(botId))?.state === 'ready';
  }

  async choose(room, spec, row) {
    const duties = room.team.duties || [];
    const registered = duties.find(duty => duty.dutyKey === row.dutyKey);
    if (registered) {
      if (room.members.includes(registered.botId) && await this.available(registered.botId, spec, row, room)) {
        if (row.existingOwnerId === registered.botId || row.responsibility === registered.responsibility)
          return { state: 'covered', botId: registered.botId };
        return { action: 'assign', botId: registered.botId };
      }
      return { state: 'blocked', botId: registered.botId, error: 'The registered owner cannot currently cover this responsibility. Its existing assignment is retained.' };
    }
    const current = duties.find(duty => duty.botId === row.existingOwnerId && duty.responsibility && duty.assignedAt &&
      !duty.staffingArea && room.members.includes(duty.botId));
    if (current && await this.available(current.botId, spec, row, room))
      return { state: 'covered', botId: current.botId };

    for (const botId of new Set([row.candidateBotId, ...room.members])) {
      if (!duties.some(duty => duty.botId === botId) && await this.available(botId, spec, row, room))
        return { action: room.members.includes(botId) ? 'assign' : 'invite', botId };
    }
    const role = spec.roles.find(role => role.id === row.roleId);
    return { action: 'create', roleId: role.id, name: role.name,
      prompt: `你是此项目的${role.name}，负责${spec.focus}。以本群最新的正式职责和当前工作授权为准。` };
  }

  saveRow(plan, original, update) {
    const areas = plan.areas.map(row => row.area === original.area ? { ...row, ...update } : row);
    const pending = areas.some(row => row.state === 'pending');
    this.store.transaction(() => {
      this.store.save(assessments, { id: plan.id, areas,
        status: pending ? 'applying' : areas.some(row => row.state === 'blocked') ? 'blocked' : 'completed',
        ...(pending ? {} : { finishedAt: now() }) });
      if (!pending) this.store.save(staffState, { id: plan.roomId, activeAssessmentId: null });
    });
  }

  schedule(room) {
    if (!coverageProject(room)) return false;
    if (this.running.has(room.id)) return true;
    const state = this.store.get(staffState, room.id);
    const plan = state?.activeAssessmentId && this.get(state.activeAssessmentId);
    if (plan?.status !== 'applying' || plan.coverageVersion !== staffingCoverageVersion || plan.actor !== room.team.eggBotId) return false;
    const coordinator = this.manager.get(plan.actor);
    if (coordinator.status !== 'active' || coordinator.runIntent === 'stopped') return true;
    const row = plan.areas.find(item => item.state === 'pending' && (!item.retryAt || item.retryAt <= Date.now()));
    if (!row) return true;
    const run = this.advance(room, plan, row)
      .catch(error => this.chatroom.emit('team-review-error', { roomId: room.id, error: error.message }))
      .finally(() => this.running.delete(room.id));
    this.running.set(room.id, run);
    return true;
  }

  async drain() { await Promise.allSettled(this.running.values()); }

  async advance(room, plan, row) {
    const spec = staffingAreas.find(item => item.area === row.area);
    const key = operationKey(plan, row);
    const operation = this.store.get('team-operations', key);
    let input = row.input;
    try {
      if (!operation?.result && (room.goal !== plan.goal || room.team.requirements !== plan.requirements))
        fail('Project scope changed after this assessment. Assess the new source before assigning this responsibility.', 409);
      if (!input) {
        const candidate = await this.choose(room, spec, row);
        const current = this.team.room(room.id, plan.actor);
        if (!coverageProject(current) || current.team.revision !== room.team.revision) return true;
        if (candidate.state) { this.saveRow(plan, row, candidate); return true; }
        input = { ...candidate, roomId: room.id, expectedRevision: current.team.revision, dutyKey: row.dutyKey,
          operationId: row.operationId, sourceMessageId: row.sourceRefs[0].messageId, reason: row.reason, responsibility: row.responsibility };
        this.saveRow(plan, row, { input });
      }
      const source = { roomId: plan.roomId, metadata: { teamStaffing: true },
        input: { metadata: { deliveryId: plan.id }, staffing: { coverageVersion: plan.coverageVersion } } };
      const receipt = operation?.result || await this.team.manage(input, plan.actor, source, {
        assessmentId: plan.id, area: row.area, goal: plan.goal, requirements: plan.requirements,
        sourceRefs: row.sourceRefs, workIds: row.workIds,
        handoff: row.items.filter(item => item.handling === 'specialist').map(item =>
          `${item.title}\n输入：${item.input}\n交付：${item.output}\n完成条件：${item.done}`).join('\n\n'),
      });
      const assigned = receipt.room?.team?.duties?.find(duty => duty.dutyKey === row.dutyKey && duty.operationId === row.operationId);
      if (!assigned || !receipt.eventMessageId || !receipt.messageId) fail('Staffing action has no confirmed assignment receipt', 409);
      this.saveRow(plan, row, { input, state: 'assigned', botId: assigned.botId, error: null,
        receipt: pick(receipt, ['operationId', 'messageId', 'eventMessageId']) });
    } catch (error) {
      const saved = this.store.get('team-operations', key);
      const current = this.chatroom.need('rooms', room.id);
      const changedBeforeWrite = !saved && input && coverageProject(current) && input.expectedRevision !== current.team.revision;
      const attempts = (row.attempts || 0) + 1;
      const retry = attempts < 4 && (changedBeforeWrite || !error.status || error.status >= 500 || error.status === 429);
      const message = String(error.message || error).slice(0, 900);
      this.saveRow(plan, row, { state: retry ? 'pending' : 'blocked', attempts,
        input: changedBeforeWrite ? null : input, retryAt: retry ? Date.now() + 5000 * attempts : null,
        firstFailure: row.firstFailure || { at: now(), message }, error: message });
    }
    return true;
  }
}
