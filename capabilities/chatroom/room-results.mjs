import { currentUserRequest } from '../../bot/src/capabilities/request-routing.mjs';
import { activeDuties } from './staffing.mjs';
import { now, pick } from '../shared/validation.mjs';

const results = 'room-text-results', acceptances = 'room-text-acceptances';

/** A room result points at an actual owner's completed delivery, never a
 * synthetic work, attachment, user instruction, or generated receipt. */
export class RoomTextResults {
  constructor(chatroom) { this.chatroom = chatroom; }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }

  async action(item, task, room, trigger) {
    if (task.status !== 'completed' || task.workId || task.cancelRequested || task.result?.partial ||
        task.result?.suspended || item.observation || item.routeOnly || item.teamStaffing ||
        !item.routedDutyKey || trigger.senderId !== 'user') return null;
    const duty = activeDuties(room, item.botId).find(duty => duty.dutyKey === item.routedDutyKey);
    if (!duty) return null;
    if (item.roomDutyAction) {
      const plan = this.chatroom.dutyActions.current(item, room);
      if (!plan) return null;
      const used = new Map();
      for (const tool of task.tools || []) {
        const details = tool.output?.details;
        const ref = details?.reference;
        if (tool.status === 'completed' && ['chatroom_read', 'evidence_read'].includes(tool.name) &&
            typeof details?.content === 'string' && details.content && ref?.type === 'room' && ref.roomId === room.id &&
            plan.publications?.some(file => file.id === ref.attachmentId && file.messageId === ref.messageId))
          used.set(ref.attachmentId, ref);
      }
      if (plan.kind === 'independent-review' && !used.size) return null;
      return { kind: plan.kind, sourceUnit: plan.grant.sourceUnit, dependency: plan.dependency, planId: plan.id,
        references: [{ type: 'room', roomId: room.id, messageId: trigger.id }, ...used.values()] };
    }
    return this.manager.readState(item.botId, db => {
      const saved = db?.getTask(task.id), user = saved && currentUserRequest(saved, db);
      const routing = user && db.getRecord('request-routing', task.id);
      return routing?.intent === 'room-deliver' && routing.roomDeliveryUnits?.length &&
        user.roomId === room.id && user.messageId === trigger.id && routing.messageId === trigger.id &&
        routing.roomId === room.id ? { kind: 'room-handoff', sourceUnit: routing.roomDeliveryUnits[0] } : null;
    });
  }

  candidate(message, room, before) {
    if (!message?.jobId || message.roomId !== room.id || message.kind === 'error' || message.workId || message.observationReply ||
        message.attachments?.length || !message.content || Date.parse(message.createdAt) >= Date.parse(before.createdAt)) return null;
    const job = this.store.get('deliveries', message.jobId), trigger = job && this.store.get('messages', job.messageId);
    const duty = room.team?.duties?.find(item => item.dutyKey === job?.routedDutyKey && item.botId === job?.botId);
    if (job?.roomId !== room.id || job.status !== 'completed' || job.workId || !job.taskId || !duty ||
        job.botId !== message.senderId || trigger?.roomId !== room.id || trigger.senderId !== 'user' ||
        message.replyTo !== trigger.id || message.id !== 'reply:' + job.id || job.observation || job.routeOnly || job.teamStaffing ||
        Date.parse(trigger.createdAt) > Date.parse(message.createdAt) ||
        duty.assignedAt && Date.parse(duty.assignedAt) > Date.parse(message.createdAt) ||
        duty.closedAt && Date.parse(duty.closedAt) <= Date.parse(message.createdAt)) return null;
    const saved = this.store.get(results, message.id);
    if (saved?.roomId === room.id && saved.deliveryId === job.id && saved.taskId === job.taskId && saved.ownerBotId === job.botId &&
        saved.sourceMessageId === trigger.id && saved.dutyKey === duty.dutyKey) return saved;
    // Older versions did not distinguish an explicit text handoff from a
    // discussion. Offer only the completed routed owner delivery as a
    // candidate. Its original request and text must pass semantic checking.
    if (job.roomDutyAction || job.input?.kind !== 'request' || job.input?.metadata?.actor !== 'user' ||
        job.input?.replyTo !== trigger.id || job.input?.content?.trigger?.id !== trigger.id) return null;
    return { id: message.id, roomId: room.id, ownerBotId: job.botId, dutyKey: duty.dutyKey, taskId: job.taskId,
      deliveryId: job.id, sourceMessageId: trigger.id, version: message.id, kind: 'room-handoff', legacyCandidate: true, publishedAt: message.createdAt };
  }

  publish(item, task, message, action) {
    if (!action || message.id !== 'reply:' + item.id || message.attachments?.length || message.workId || !message.content) return null;
    const record = this.store.save(results, { id: message.id, roomId: item.roomId, ownerBotId: item.botId, dutyKey: item.routedDutyKey,
      taskId: task.id, deliveryId: item.id, sourceMessageId: item.messageId, version: message.id, publishedAt: message.createdAt, ...action });
    this.link(record);
    return record;
  }

  link(record) {
    const room = this.chatroom.need('rooms', record.roomId);
    const duty = room.team?.duties?.find(item => item.dutyKey === record.dutyKey && item.botId === record.ownerBotId);
    if (!duty || duty.resultIds?.includes(record.id)) return;
    this.chatroom.teamService.change(room, { team: { duties: room.team.duties.map(item =>
      item === duty ? { ...item, resultIds: [...(item.resultIds || []), record.id] } : item) } }, room.team.revision);
  }

  before(room, trigger) {
    const messages = this.chatroom.messages(room.id);
    const options = messages.filter(message => message.jobId && message.senderId !== 'user' &&
      Date.parse(message.createdAt) < Date.parse(trigger.createdAt)).reverse();
    if (trigger.replyTo) options.sort((left, right) => Number(right.id === trigger.replyTo) - Number(left.id === trigger.replyTo));
    const candidates = [];
    for (const message of options) {
      const record = this.candidate(message, room, trigger);
      if (!record) continue;
      const source = this.store.get('messages', record.sourceMessageId);
      if (record.legacyCandidate && (source.content.length > 4000 || message.content.length > 4000)) continue;
      candidates.push({ ...record, content: message.content.slice(0, 4000), originalRequest: source.content.slice(0, 4000) });
      if (candidates.length === 12) break;
    }
    return candidates;
  }

  record(room, trigger, item, task) {
    const decisions = (task.tools || []).filter(tool => tool.name === 'request_decide' && tool.status === 'completed')
      .map(tool => tool.output?.details).filter(receipt => receipt?.messageId === trigger.id && receipt.roomId === room.id &&
        receipt.acceptanceReceiptTaskId === task.id).flatMap(receipt => receipt.roomResultAcceptances || []);
    const changes = [];
    for (const decision of decisions) {
      const message = this.store.get('messages', decision.publicationMessageId);
      const candidate = this.candidate(message, room, trigger);
      if (!candidate || candidate.version !== decision.version || candidate.ownerBotId !== decision.ownerBotId ||
          candidate.dutyKey !== decision.dutyKey || candidate.sourceMessageId !== decision.sourceMessageId ||
          candidate.taskId !== decision.taskId || candidate.legacyCandidate && decision.legacyRoomDelivery !== true) continue;
      const id = JSON.stringify([room.id, trigger.id, candidate.version]);
      if (this.store.get(acceptances, id)) continue;
      if (candidate.legacyCandidate) {
        const { legacyCandidate, ...identity } = candidate;
        this.store.save(results, { ...identity, certifiedByAcceptance: trigger.id });
        this.link(candidate);
      }
      const record = this.store.save(acceptances, { id, roomId: room.id, resultId: candidate.id, version: candidate.version,
        dutyKey: candidate.dutyKey, ownerBotId: candidate.ownerBotId, sourceMessageId: trigger.id, deliveryId: item.id,
        ...pick(decision, ['scope', 'remainingBoundaries', 'fullScope', 'clauses']), recordedAt: now() });
      changes.push({ key: 'room-acceptance:' + id, kind: 'room-result-acceptance', messageId: trigger.id, resultId: record.resultId });
    }
    return changes;
  }
}
