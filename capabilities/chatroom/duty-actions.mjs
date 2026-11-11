import { randomUUID } from 'node:crypto';
import { ROOM_DUTY_PLANS, dependencyDispatches, roomDutyPlanId } from '../../bot/src/context/duty-actions.mjs';
import { currentUserRequest, requireProductionGrant } from '../../bot/src/capabilities/request-routing.mjs';
import { acceptedWorkTask } from '../../bot/src/context/sources.mjs';
import { externalExecution } from '../../bot/src/context/execution-evidence.mjs';
import { activeDuties, staffingArtifacts, staffingProject } from './staffing.mjs';
import { now, pick } from '../shared/validation.mjs';

const stopped = new Set(['failed', 'cancelled', 'interrupted']);
const pending = new Set(['waiting', 'queued']);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// This ledger owns a room handoff. It is neither a work card nor evidence
// that an owner has acted. Only the delivery and its final publication are.
export class RoomDutyActions {
  constructor(chatroom) { this.chatroom = chatroom; }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }
  get(id) { return id && this.store.get(ROOM_DUTY_PLANS, id); }
  view(roomId) {
    return this.store.list(ROOM_DUTY_PLANS).filter(plan => plan.roomId === roomId).slice(-20)
      .map(plan => pick(plan, ['id', 'kind', 'status', 'messageId', 'goal', 'dutyKey', 'ownerBotId',
        'deliveryId', 'dependency', 'resultMessageId', 'waitingFor', 'error']));
  }

  async import(item, room, trigger, task) {
    if (!staffingProject(room) || item.observation || item.routeOnly || item.teamStaffing || item.roomDutyAction ||
        item.teamIntroduction || trigger.senderId !== 'user' || task.workId || task.cancelRequested ||
        ['cancelled', 'interrupted'].includes(task.status)) return [];
    const plans = await this.manager.readState(item.botId, db => {
      const saved = db?.getTask(item.taskId), user = saved && currentUserRequest(saved, db);
      if (user?.roomId !== room.id || user.messageId !== trigger.id) return [];
      return db.listRecords(ROOM_DUTY_PLANS).filter(plan => {
        const grant = plan.grant;
        if (!grant || plan.requestTaskId !== task.id || plan.coordinatorBotId !== item.botId ||
            plan.roomId !== room.id || plan.messageId !== trigger.id || !['independent-review', 'contribution'].includes(plan.kind) ||
            plan.id !== roomDutyPlanId({ ...plan, sourceUnit: grant.sourceUnit })) return false;
        const dependent = plan.kind === 'independent-review';
        try {
          requireProductionGrant(saved, db, grant, {
            actionId: dependent ? plan.id : plan.operationId, workId: dependent ? null : plan.workId, relation: 'new',
            when: dependent ? 'after-dependency' : 'now',
          });
        } catch { return false; }
        if (grant.participant?.dutyKey !== plan.dutyKey) return false;
        if (dependent) return grant.participant?.independent === true && same(plan.dependency, grant.after) && plan.dependency?.roomId === room.id &&
          plan.dependency.messageId === trigger.id && plan.dependency.condition === 'successful-publication';
        const event = db.getRecord('work-events', plan.operationId);
        return grant.participant?.contribution === plan.goal && event?.receipt?.accepted && event.workId === plan.workId &&
          event.authorization?.production?.actionId === grant.actionId;
      });
    });
    const imported = [];
    for (const plan of plans) {
      if (this.get(plan.id)) continue;
      const references = (plan.references || []).filter(ref => {
        const message = this.store.get('messages', ref.messageId);
        return ref.roomId === room.id && message?.roomId === room.id &&
          (!ref.attachmentId || staffingArtifacts(message).some(artifact => artifact.id === ref.attachmentId));
      });
      imported.push(this.store.save(ROOM_DUTY_PLANS, { ...plan, references, status: 'waiting',
        waitingFor: plan.kind === 'independent-review' ? 'publication' : 'responsible-member',
        originalRoomGoal: room.goal, originalTeamRequirements: room.team.requirements,
        deliveryId: 'duty-action:' + randomUUID() }));
    }
    return imported;
  }

  async dependency(plan) {
    const exact = plan.dependency;
    return this.manager.readState(plan.coordinatorBotId, db => {
      const accepted = dependencyDispatches(db, exact);
      if (accepted.length > 1) return { failure: '同一原请求对应多个先行操作，未确认本次依赖。' };
      const operation = accepted[0];
      if (!operation) return { wait: 'accepted-operation' };
      if (exact.operationId && (operation.id !== exact.operationId || operation.receipt.taskId !== exact.taskId))
        return { failure: '先行操作已与登记的执行回执不符。' };
      const work = db.getRecord('works', operation.workId), task = acceptedWorkTask(operation, db);
      if (!work || !task || work.botId !== plan.coordinatorBotId ||
          (work.project?.id ?? null) !== operation.authorization.production.projectId) return { wait: 'confirmed-work' };
      const selection = { ...exact, workId: work.id, taskId: task.id, operationId: operation.id };
      if (stopped.has(task.status) || work.status === 'cancelled') return { failure: '先行执行未成功，后续复核没有启动。' };
      if (work.status === 'paused' || work.status === 'blocked') return { wait: 'dependency-paused-or-blocked', selection };
      if (task.status !== 'completed' || task.result?.partial || task.result?.suspended) return { wait: 'successful-execution', selection };
      const native = work.executor?.kind === 'codex' || work.bindings?.some(item => item.type === 'codex-desktop');
      if (native) {
        const execution = externalExecution(work, operation.id);
        if (stopped.has(execution.status)) return { failure: '先行的外部执行未成功，后续复核没有启动。' };
        if (execution.status !== 'completed' || !execution.startedConfirmed || !execution.externalReceived ||
            execution.currentOperationId !== operation.id || work.executionOutcome?.operationId !== operation.id ||
            work.executionOutcome?.finalConfirmed !== true) return { wait: 'confirmed-external-result', selection };
      }
      const receipts = db.listRecords('work-notifications').filter(notification =>
        notification.workId === work.id && notification.roomId === plan.roomId && notification.replyTo === plan.messageId &&
        notification.status === 'delivered' && !notification.late && notification.resultKind !== 'progress' &&
        notification.executionEventId === operation.id &&
        (native ? notification.publication === 'external' && notification.resultKind === 'execution-ended' :
          notification.publication === 'explicit' && notification.taskId === task.id));
      const publications = new Map();
      for (const notification of receipts) for (const saved of [notification.receipt].flat()) {
        const message = saved?.id && this.store.get('messages', saved.id);
        if (message?.roomId !== plan.roomId || message.replyTo !== plan.messageId || message.senderId !== work.botId ||
            message.workId !== work.id || message.eventType !== 'work_result') continue;
        for (const artifact of staffingArtifacts(message)) {
          const record = this.chatroom.attachments.publication(artifact.id).attachment;
          if (artifact.operationId !== operation.id || !notification.attachments?.some(item => item.id === artifact.id) ||
              !record || record.origin?.roomId !== plan.roomId || record.origin.botId !== work.botId ||
              record.origin.workId !== work.id || record.origin.operationId !== operation.id) continue;
          publications.set(artifact.id, artifact);
        }
      }
      if (publications.size < selection.minimumAttachments) return { wait: 'confirmed-publication', selection };
      return { selection, publications: [...publications.values()], makerBotId: work.botId };
    });
  }

  async advance(room) {
    for (const saved of this.store.list(ROOM_DUTY_PLANS).filter(plan => plan.roomId === room.id && pending.has(plan.status))) {
      const plan = this.get(saved.id);
      if (!plan || plan.status !== 'waiting' || plan.retryAt > Date.now()) continue;
      if (!staffingProject(room)) continue;
      if (room.goal !== plan.originalRoomGoal || room.team.requirements !== plan.originalTeamRequirements) {
        this.block(plan, '项目范围已变更，原条件下的接力未启动。');
        continue;
      }
      const independent = plan.kind === 'independent-review';
      const dependency = independent ? await this.dependency(plan).catch(() => ({ wait: 'dependency-state-unavailable' })) : {};
      if (dependency?.failure) { this.block(plan, dependency.failure); continue; }
      if (dependency?.wait) {
        this.defer(plan, dependency.wait, dependency.selection);
        continue;
      }
      const duties = activeDuties(room).filter(duty => duty.botId !== (dependency?.makerBotId || plan.coordinatorBotId) &&
        duty.botId !== room.team.eggBotId && Boolean(duty.dutyProfile?.independentReview) === independent &&
        (plan.dutyKey ? plan.dutyKey === duty.dutyKey :
          (duty.sourceRefs || []).some(ref => ref.roomId === room.id && ref.messageId === plan.messageId)));
      if (duties.length !== 1) {
        this.defer(plan, duties.length ? 'ambiguous-responsible-member' : 'responsible-member', dependency?.selection);
        continue;
      }
      const duty = duties[0], bot = this.manager.get(duty.botId);
      if (bot.status !== 'active' || bot.runIntent !== 'running' || bot.archivedAt) {
        this.defer(plan, 'responsible-member-unavailable', dependency?.selection);
        continue;
      }
      const trigger = this.chatroom.need('messages', plan.messageId);
      this.store.transaction(() => {
        this.chatroom.enqueue(trigger, duty.botId, { id: plan.deliveryId, roomDutyAction: plan.id,
          routedDutyKey: duty.dutyKey, workId: null, priority: 'background' });
        this.store.save(ROOM_DUTY_PLANS, { id: plan.id, status: 'queued', ownerBotId: duty.botId, dutyKey: duty.dutyKey,
          ...(dependency?.selection ? { dependency: dependency.selection } : {}), publications: dependency?.publications || [],
          waitingFor: null, retryAt: null, queuedAt: now() });
      });
    }
  }

  defer(plan, waitingFor, dependency) {
    this.store.save(ROOM_DUTY_PLANS, { id: plan.id, waitingFor, retryAt: Date.now() + 3000,
      ...(dependency ? { dependency } : {}) });
  }
  block(plan, error) {
    this.store.transaction(() => {
      this.store.save(ROOM_DUTY_PLANS, { id: plan.id, status: 'blocked', error, finishedAt: now() });
      this.chatroom.append(plan.roomId, { clientId: 'duty-action-blocked:' + plan.id, replyTo: plan.messageId,
        kind: 'event', eventType: 'team_result', purpose: 'fyi', content: error }, 'system');
    });
  }
  current(item, room) {
    const plan = this.get(item.roomDutyAction);
    return plan?.status === 'queued' && plan.deliveryId === item.id && plan.roomId === item.roomId &&
      plan.messageId === item.messageId && plan.ownerBotId === item.botId &&
      staffingProject(room) && room.goal === plan.originalRoomGoal && room.team.requirements === plan.originalTeamRequirements &&
      activeDuties(room, item.botId).some(duty => duty.dutyKey === plan.dutyKey) ? plan : null;
  }
  finish(item, status, resultMessageId) {
    const plan = this.get(item.roomDutyAction);
    if (plan?.status !== 'queued' || plan.deliveryId !== item.id) return;
    this.store.save(ROOM_DUTY_PLANS, { id: plan.id, status: resultMessageId ? 'completed' : 'blocked',
      resultMessageId: resultMessageId || null, finishedAt: now(),
      ...(resultMessageId ? {} : { error: status === 'completed' ? '职责执行没有发出可用结果。' : '职责执行未完成。' }) });
  }
}
