import { randomUUID } from 'node:crypto';
import { EXISTING_PUBLICATION, OWNER_DELIVERY, ROOM_DUTY_PLANS, dependencyDispatches, matchesContributionGrant, publishedReviewTarget, reviewReferenceAttachments, roomDutyPlanId, sourceDispatches } from '../../bot/src/context/duty-actions.mjs';
import { currentUserRequest, requireProductionGrant } from '../../bot/src/capabilities/request-routing.mjs';
import { acceptedWorkTask } from '../../bot/src/context/sources.mjs';
import { externalExecution } from '../../bot/src/context/execution-evidence.mjs';
import { activeDuties, staffingArtifacts, staffingProject } from './staffing.mjs';
import { fail, now, pick } from '../shared/validation.mjs';

const stopped = new Set(['failed', 'cancelled', 'interrupted']);
const pending = new Set(['waiting', 'queued']);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameOwnerAssignment = (plan, duty) => !plan.dependency?.ownerAssignedAt || duty.assignedAt === plan.dependency.ownerAssignedAt;

// This ledger owns a room handoff. It is neither a work card nor evidence
// that an owner has acted. Only the delivery and its final publication are.
export class RoomDutyActions {
  constructor(chatroom) { this.chatroom = chatroom; }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }
  get(id) { return id && this.store.get(ROOM_DUTY_PLANS, id); }
  references(roomId, references = []) {
    return references.filter(ref => {
      const message = this.store.get('messages', ref.messageId);
      return ref.roomId === roomId && message?.roomId === roomId &&
        (!ref.attachmentId || staffingArtifacts(message).some(artifact => artifact.id === ref.attachmentId));
    });
  }
  materials(roomId, evidence = []) {
    return evidence.flatMap(item => {
      const ref = item.reference;
      const message = ref?.type === 'room' && ref.attachmentId && this.store.get('messages', ref.messageId);
      if (ref?.roomId !== roomId || message?.roomId !== roomId || message.senderId !== item.author ||
          !staffingArtifacts(message).some(artifact => artifact.id === ref.attachmentId) || typeof item.content !== 'string') return [];
      return [pick(item, ['reference', 'author', 'name', 'content', 'offset', 'fullCharacters', 'nextOffset'])];
    }).slice(0, 6);
  }
  view(roomId) {
    return this.store.list(ROOM_DUTY_PLANS).filter(plan => plan.roomId === roomId).slice(-20)
      .map(plan => pick(plan, ['id', 'kind', 'status', 'messageId', 'goal', 'dutyKey', 'ownerBotId',
        'deliveryId', 'workId', 'operationId', 'dependency', 'resultMessageId', 'waitingFor', 'error']));
  }

  async import(item, room, trigger, task) {
    if (!staffingProject(room) || item.observation || item.routeOnly || item.teamStaffing || item.roomDutyAction ||
        item.teamIntroduction || trigger.senderId !== 'user' || task.workId || task.cancelRequested || task.status === 'cancelled') return [];
    const plans = await this.manager.readState(item.botId, db => {
      const saved = db?.getTask(item.taskId), user = saved && currentUserRequest(saved, db);
      const accepted = user && db.getMessage(user.acceptedMessageId);
      if (user?.roomId !== room.id || user.messageId !== trigger.id || user.text !== trigger.content ||
          (user.replyTo || null) !== (trigger.replyTo || null) || accepted?.sourceMessageId !== item.id ||
          accepted.content?.metadata?.deliveryId !== item.id) return [];
      return db.listRecords(ROOM_DUTY_PLANS).flatMap(plan => {
        const grant = plan.grant;
        if (!grant || plan.requestTaskId !== task.id || plan.coordinatorBotId !== item.botId ||
            plan.roomId !== room.id || plan.messageId !== trigger.id || !['independent-review', 'contribution'].includes(plan.kind) ||
            plan.id !== roomDutyPlanId({ ...plan, sourceUnit: grant.sourceUnit })) return [];
        const dependent = plan.kind === 'independent-review';
        const relation = dependent ? 'new' : grant.relation;
        const ownerDelivery = plan.dependency?.condition === OWNER_DELIVERY;
        const existingPublication = plan.dependency?.condition === EXISTING_PUBLICATION;
        if (!['new', 'continue'].includes(relation)) return [];
        try {
          requireProductionGrant(saved, db, grant, {
            actionId: dependent ? plan.id : plan.operationId, workId: dependent ? null : plan.workId, relation,
            when: dependent && !existingPublication || ownerDelivery ? 'after-dependency' : 'now',
          });
        } catch { return []; }
        if (grant.participant?.dutyKey !== plan.dutyKey) return [];
        if (dependent) return task.status !== 'interrupted' && grant.participant?.independent === true &&
          same(plan.dependency, grant.after) && plan.dependency?.roomId === room.id && plan.dependency.messageId === trigger.id &&
          (existingPublication || plan.dependency.condition === 'successful-publication') ? [plan] : [];
        const event = db.getRecord('work-events', plan.operationId);
        const gatesProduction = event?.contributionPlanId === plan.id;
        if (!gatesProduction || (ownerDelivery || relation === 'continue') && !plan.dutyKey || !matchesContributionGrant(plan, grant) ||
            event.requestTaskId !== saved.id || event.content?.stage?.kind !== grant.stage ||
            event.authorization?.source?.actor !== 'user' || event.authorization.source.roomId !== room.id ||
            event.authorization.source.replyTo !== trigger.id || !same(event.authorization.production, grant)) return [];
        return event.workId === plan.workId && (event.receipt?.accepted || event.status === 'pending') ? [{ ...plan, gatesProduction,
            referenceMaterials: this.materials(room.id, event.content?.evidence) }] : [];
      });
    });
    const imported = [];
    for (const plan of plans) {
      if (this.get(plan.id)) continue;
      const references = this.references(room.id, plan.references);
      const scoped = plan.gatesProduction || plan.dependency?.condition === EXISTING_PUBLICATION;
      imported.push(this.store.save(ROOM_DUTY_PLANS, { ...plan, references, status: 'waiting',
        waitingFor: plan.dependency?.condition === 'successful-publication' ? 'publication' : 'responsible-member',
        originalRoomGoal: scoped ? plan.originalRoomGoal : room.goal,
        originalTeamRequirements: scoped ? plan.originalTeamRequirements : room.team.requirements,
        deliveryId: 'duty-action:' + randomUUID() }));
    }
    return imported;
  }

  async coordinatorState(plan) {
    if (!plan.gatesProduction) return 'waiting';
    return this.manager.readState(plan.coordinatorBotId, db => {
      const work = db?.getRecord('works', plan.workId), operation = db?.getRecord('work-events', plan.operationId);
      const original = db?.getTask(plan.requestTaskId);
      if (!work || work.waiting?.operationId !== operation?.id || operation?.contributionPlanId !== plan.id ||
          operation.status !== 'pending' || !original || original.cancelRequested || original.status === 'cancelled') return 'stopped';
      if (plan.dependency?.condition === OWNER_DELIVERY && (!matchesContributionGrant(plan, operation.authorization?.production) ||
          work.botId !== plan.coordinatorBotId || (work.project?.id ?? null) !== plan.dependency.projectId ||
          work.status !== 'paused' && (work.controlRevision || 0) !== operation.contributionControlRevision)) return 'stopped';
      return work.status;
    });
  }

  readContribution(input, actor, source) {
    const { planId, operationId, workId } = input.dutyContribution;
    const room = this.chatroom.need('rooms', input.roomId);
    const trigger = this.store.get('messages', source?.replyTo);
    if (source?.source !== 'controller' || source.actor !== 'user' || source.roomId !== room.id ||
        trigger?.roomId !== room.id || trigger.senderId !== 'user' || !room.members.includes('user') || !room.members.includes(actor))
      fail('Contribution is outside the authenticated production source', 403);
    const plan = this.get(planId);
    if (!plan) return staffingProject(room) ? { status: 'waiting', waitingFor: 'registered-room-plan' } :
      { status: 'blocked', error: '项目群当前无法接收原请求的职责协作。' };
    if (!plan.gatesProduction || plan.kind !== 'contribution' || plan.workId !== workId || plan.operationId !== operationId ||
        plan.coordinatorBotId !== actor || plan.roomId !== room.id || plan.messageId !== trigger.id || plan.requestTaskId !== source.taskId)
      fail('Contribution does not match this production operation', 403);
    if (room.goal !== plan.originalRoomGoal || room.team?.requirements !== plan.originalTeamRequirements)
      return { status: 'blocked', error: '项目范围已变更，原职责结果未用于制作。' };
    if (plan.status !== 'completed') return pick(plan, ['status', 'waitingFor', 'ownerBotId', 'error']);
    const message = this.store.get('messages', plan.resultMessageId), delivery = this.store.get('deliveries', plan.deliveryId);
    const result = message && this.store.get('room-text-results', message.id);
    const ownerDelivery = plan.dependency?.condition === OWNER_DELIVERY;
    if (message?.roomId !== room.id || message.id !== `reply:${plan.deliveryId}` || message.jobId !== plan.deliveryId ||
        message.senderId !== plan.ownerBotId || message.replyTo !== trigger.id || !room.members.includes(plan.ownerBotId) ||
        delivery?.status !== 'completed' || delivery.roomDutyAction !== plan.id || result?.kind !== 'contribution' || result.planId !== plan.id ||
        result.ownerBotId !== plan.ownerBotId || result.taskId !== delivery.taskId || result.deliveryId !== delivery.id ||
        result.dutyKey !== plan.dutyKey || result.sourceMessageId !== trigger.id || result.sourceUnit !== plan.grant.sourceUnit ||
        ownerDelivery && (!message.content?.trim() || result.workId !== workId || result.operationId !== operationId ||
          !same(result.dependency, plan.dependency) || delivery.routedDutyKey !== plan.dutyKey || delivery.messageId !== trigger.id ||
          delivery.botId !== plan.ownerBotId || !activeDuties(room, plan.ownerBotId).some(duty =>
            duty.dutyKey === plan.dutyKey && !duty.dutyProfile?.independentReview && sameOwnerAssignment(plan, duty))))
      return { status: 'blocked', error: '职责回复与原制作操作的群内交付回执未能对上。' };
    return { status: 'completed', planId: plan.id, operationId, workId, sourceMessageId: trigger.id,
      dutyKey: plan.dutyKey, deliveryId: delivery.id, taskId: delivery.taskId, publishedAt: message.createdAt,
      ...(ownerDelivery ? { dependency: plan.dependency } : {}),
      evidence: { reference: { type: 'room', roomId: room.id, messageId: message.id }, author: message.senderId,
        content: message.content, sourceRefs: result.references, authority: 'published-duty-contribution' } };
  }

  existingPublication(plan) {
    const target = plan.dependency.publication;
    const message = target && this.store.get('messages', target.messageId);
    const original = target && this.store.get('messages', target.sourceMessageId);
    const trigger = this.store.get('messages', plan.messageId);
    if (!target || !same(publishedReviewTarget(message, plan.roomId, target.attachmentIds), target) ||
        original?.roomId !== plan.roomId || original.senderId !== 'user' || trigger?.roomId !== plan.roomId ||
        trigger.senderId !== 'user' || !(Date.parse(message.createdAt) < Date.parse(trigger.createdAt))) return null;
    return { makerBotId: target.makerBotId, publications: staffingArtifacts(message).filter(file => target.attachmentIds.includes(file.id)) };
  }

  async dependency(plan) {
    if (plan.dependency.condition === EXISTING_PUBLICATION) {
      const current = this.existingPublication(plan);
      if (!current) return { failure: '原群已发布的复核材料无法确认，未启动独立复核。' };
      if (current.publications.some(file => {
        const origin = this.chatroom.attachments.publication(file.id).attachment?.origin;
        return origin?.publicationId !== file.id || origin.botId !== current.makerBotId || origin.roomId !== plan.roomId ||
          origin.workId !== file.workId || origin.operationId !== file.operationId;
      })) return { failure: '原发布附件已不可用，未启动独立复核。' };
      return current;
    }
    const exact = plan.dependency;
    return this.manager.readState(plan.coordinatorBotId, db => {
      const accepted = dependencyDispatches(db, exact);
      if (accepted.length > 1) return { failure: '同一原请求对应多个先行操作，未确认本次依赖。' };
      const operation = accepted[0];
      if (!operation) {
        const waiting = sourceDispatches(db, { ...exact, includeRegistered: true }).find(event => event.contributionPlanId);
        const work = waiting && db.getRecord('works', waiting.workId);
        if (waiting?.status === 'superseded' || work?.status === 'cancelled') return { failure: '原先行制作已停止或被替代，未启动独立复核。' };
        return { wait: 'accepted-operation' };
      }
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
      const referenceMaterials = this.materials(plan.roomId, operation.content?.evidence);
      return { selection, publications: [...publications.values()], referenceMaterials, makerBotId: work.botId };
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
      if (!independent && plan.gatesProduction) {
        const state = await this.coordinatorState(plan).catch(() => null);
        if (state === 'stopped' || state === 'cancelled') { this.block(plan, '原制作步骤已停止或被后续授权替代。'); continue; }
        if (state !== 'waiting') { this.defer(plan, 'coordinator-not-ready'); continue; }
      }
      const dependency = independent ? await this.dependency(plan).catch(() => ({ wait: 'dependency-state-unavailable' })) : {};
      if (dependency?.failure) { this.block(plan, dependency.failure); continue; }
      if (dependency?.wait) {
        this.defer(plan, dependency.wait, dependency.selection);
        continue;
      }
      const currentRoom = this.chatroom.need('rooms', room.id);
      if (!staffingProject(currentRoom) || currentRoom.goal !== plan.originalRoomGoal ||
          currentRoom.team.requirements !== plan.originalTeamRequirements || this.get(plan.id)?.status !== 'waiting') continue;
      const excludedOwner = independent ? dependency.makerBotId :
        plan.dependency?.condition === OWNER_DELIVERY && plan.grant.relation === 'new' ? null : plan.coordinatorBotId;
      const duties = activeDuties(currentRoom).filter(duty => duty.botId !== excludedOwner &&
        duty.botId !== currentRoom.team.eggBotId && Boolean(duty.dutyProfile?.independentReview) === independent &&
        sameOwnerAssignment(plan, duty) &&
        (!plan.ownerBotId || duty.botId === plan.ownerBotId) &&
        (plan.dutyKey ? plan.dutyKey === duty.dutyKey :
          (duty.sourceRefs || []).some(ref => ref.roomId === room.id && ref.messageId === plan.messageId)));
      if (duties.length !== 1) {
        this.defer(plan, duties.length ? 'ambiguous-responsible-member' : 'responsible-member', dependency?.selection);
        continue;
      }
      const duty = duties[0], bot = this.manager.get(duty.botId);
      if (bot.status !== 'active' || bot.runIntent !== 'running' || bot.archivedAt || !bot.allowedTools?.includes('chatroom_read')) {
        this.defer(plan, 'responsible-member-unavailable', dependency?.selection);
        continue;
      }
      const trigger = this.chatroom.need('messages', plan.messageId);
      this.store.transaction(() => {
        this.chatroom.enqueue(trigger, duty.botId, { id: plan.deliveryId, roomDutyAction: plan.id,
          routedDutyKey: duty.dutyKey, workId: null, priority: 'background' });
        this.store.save(ROOM_DUTY_PLANS, { id: plan.id, status: 'queued', ownerBotId: duty.botId, dutyKey: duty.dutyKey,
          ...(dependency?.selection ? { dependency: dependency.selection } : {}), publications: dependency?.publications || [],
          ...(dependency?.referenceMaterials?.length ? { referenceMaterials: dependency.referenceMaterials,
            references: [...plan.references, ...dependency.referenceMaterials.map(item => item.reference)] } : {}),
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
    const independent = plan?.kind === 'independent-review';
    return plan?.status === 'queued' && plan.deliveryId === item.id && plan.roomId === item.roomId &&
      plan.messageId === item.messageId && plan.ownerBotId === item.botId && plan.dutyKey === item.routedDutyKey &&
      staffingProject(room) && room.goal === plan.originalRoomGoal && room.team.requirements === plan.originalTeamRequirements &&
      activeDuties(room, item.botId).some(duty => duty.dutyKey === plan.dutyKey &&
        Boolean(duty.dutyProfile?.independentReview) === independent && sameOwnerAssignment(plan, duty)) &&
      (plan.dependency?.condition !== EXISTING_PUBLICATION || this.existingPublication(plan) &&
        item.botId !== plan.dependency.publication.makerBotId) ? plan : null;
  }
  finish(item, status, resultMessageId, reason) {
    const plan = this.get(item.roomDutyAction);
    if (plan?.status !== 'queued' || plan.deliveryId !== item.id) return;
    if (!resultMessageId && status === 'completed' && plan.dependency?.condition === EXISTING_PUBLICATION) {
      const references = reviewReferenceAttachments(plan.dependency);
      return this.block(plan, references.length ?
        `独立复核未形成有完整附件读取依据的结果。历史对照待查：${references.map(ref => `《${ref.name}》`).join('、')}。` :
        '独立复核未取得与原发布附件对应的可用结果。');
    }
    this.store.save(ROOM_DUTY_PLANS, { id: plan.id, status: resultMessageId ? 'completed' : 'blocked',
      resultMessageId: resultMessageId || null, finishedAt: now(),
      ...(resultMessageId ? {} : { error: reason || (status === 'completed' ? '职责执行没有发出可用结果。' : '职责执行未完成。') }) });
  }
}
