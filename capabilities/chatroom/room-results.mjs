import { currentUserRequest } from '../../bot/src/capabilities/request-routing.mjs';
import { acceptanceClockTimes } from '../../bot/src/capabilities/acceptance-identity.mjs';
import { localTime } from '../../bot/src/context/fact-time.mjs';
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
      if (plan.gatesProduction && !['waiting', 'paused'].includes(await this.chatroom.dutyActions.coordinatorState(plan))) return null;
      const used = new Map();
      const publications = plan.publications || [];
      for (const tool of task.tools || []) {
        const details = tool.output?.details;
        const ref = details?.reference;
        if (tool.status === 'completed' && ['chatroom_read', 'evidence_read'].includes(tool.name) &&
            typeof details?.content === 'string' && details.content && ref?.type === 'room' && ref.roomId === room.id &&
            [...publications, ...(plan.references || [])].some(file => (file.attachmentId || file.id) === ref.attachmentId && file.messageId === ref.messageId))
          used.set(ref.attachmentId, ref);
      }
      if (plan.kind === 'independent-review' && !publications.some(file => used.has(file.id))) return null;
      return { kind: plan.kind, sourceUnit: plan.grant.sourceUnit, dependency: plan.dependency, planId: plan.id,
        references: [{ type: 'room', roomId: room.id, messageId: trigger.id }, ...used.values()] };
    }
    return this.manager.readState(item.botId, db => {
      const saved = db?.getTask(task.id), user = saved && currentUserRequest(saved, db);
      const routing = user && db.getRecord('request-routing', task.id);
      return routing?.intent === 'room-deliver' && routing.roomDeliveryUnits?.length &&
        user.roomId === room.id && user.messageId === trigger.id && routing.messageId === trigger.id &&
        routing.roomId === room.id ? { kind: 'room-handoff', sourceUnit: routing.roomDeliveryUnits[0],
          singleScope: routing.roomDeliveryUnits.length === 1 && !routing.sourceActions?.length } : null;
    });
  }

  candidate(message, room, before) {
    if (!message?.jobId || message.roomId !== room.id || message.kind === 'error' || message.purpose === 'fyi' || message.workId || message.observationReply ||
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

  async verifyLegacy(candidate, original, message) {
    if (!original || original.content.length > 4000 || message.content.length > 4000) return false;
    return this.manager.readState(candidate.ownerBotId, db => {
      const task = db?.getTask(candidate.taskId), user = task && currentUserRequest(task, db);
      const routing = user && db.getRecord('request-routing', task.id);
      return task?.status === 'completed' && !task.cancelRequested && !task.result?.partial && !task.result?.suspended &&
        !task.result?.attachments?.length && !task.result?.handoff && task.result?.content?.trim() === message.content &&
        user?.roomId === candidate.roomId && user.messageId === candidate.sourceMessageId && user.text === original.content &&
        routing?.roomId === user.roomId && routing.messageId === user.messageId &&
        (routing.intent === 'discuss' || routing.intent === 'room-deliver' && routing.roomDeliveryUnits?.length);
    });
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

  async before(room, trigger) {
    const messages = trigger.replyTo ? [this.store.get('messages', trigger.replyTo)] : this.chatroom.messages(room.id).reverse();
    const times = acceptanceClockTimes(trigger.content);
    const candidates = [];
    let complete = true;
    let unavailable = false;
    for (const message of messages) {
      const record = this.candidate(message, room, trigger);
      if (!record) continue;
      if (candidates.length >= 12 && !times.includes(localTime(message.createdAt)?.slice(11, 16))) { complete = false; continue; }
      const source = this.store.get('messages', record.sourceMessageId);
      if (record.legacyCandidate) {
        const verified = await this.verifyLegacy(record, source, message).catch(() => null);
        if (verified === null) unavailable = true;
        if (!verified) continue;
      }
      candidates.push({ ...record, content: message.content.slice(0, 4000), originalRequest: source.content.slice(0, 4000) });
    }
    return { roomResults: candidates, roomResultsComplete: complete && !unavailable, unavailable };
  }

  async record(room, trigger, item, task) {
    const decisions = (task.tools || []).filter(tool => tool.name === 'request_decide' && tool.status === 'completed')
      .map(tool => tool.output?.details).filter(receipt => receipt?.messageId === trigger.id && receipt.roomId === room.id &&
        receipt.acceptanceReceiptTaskId === task.id).flatMap(receipt => receipt.roomResultAcceptances || []);
    const changes = [];
    for (const decision of decisions) {
      const message = this.store.get('messages', decision.publicationMessageId);
      const candidate = this.candidate(message, room, trigger);
      if (!candidate || candidate.version !== decision.version || candidate.ownerBotId !== decision.ownerBotId ||
          candidate.dutyKey !== decision.dutyKey || candidate.sourceMessageId !== decision.sourceMessageId ||
          candidate.taskId !== decision.taskId || candidate.deliveryId !== decision.deliveryId) continue;
      if (candidate.legacyCandidate && (decision.legacyRoomDelivery !== true ||
          !await this.verifyLegacy(candidate, this.store.get('messages', candidate.sourceMessageId), message))) continue;
      this.store.transaction(() => {
        const id = JSON.stringify([room.id, trigger.id, candidate.version]);
        if (this.store.get(acceptances, id)) return;
        const current = this.candidate(message, this.chatroom.need('rooms', room.id), trigger);
        if (current?.version !== candidate.version || current.taskId !== candidate.taskId) return;
        if (current.legacyCandidate) {
          const { legacyCandidate, ...identity } = current;
          this.store.save(results, { ...identity, certifiedByAcceptance: trigger.id });
          this.link(current);
        }
        const record = this.store.save(acceptances, { id, roomId: room.id, resultId: current.id, version: current.version,
          dutyKey: current.dutyKey, ownerBotId: current.ownerBotId, sourceMessageId: trigger.id, deliveryId: item.id,
          ...pick(decision, ['scope', 'remainingBoundaries', 'fullScope', 'clauses']), recordedAt: now() });
        changes.push({ key: 'room-acceptance:' + id, kind: 'room-result-acceptance', messageId: trigger.id, resultId: record.resultId });
      });
    }
    return changes;
  }
}
