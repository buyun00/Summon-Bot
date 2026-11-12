import { basename } from 'node:path';
import { currentUserRequest } from '../../bot/src/capabilities/request-routing.mjs';
import { acceptanceClockTimes, sameRoomResultAcceptance } from '../../bot/src/capabilities/acceptance-identity.mjs';
import { EXISTING_PUBLICATION, OWNER_DELIVERY, reviewReferenceAttachments } from '../../bot/src/context/duty-actions.mjs';
import { localTime } from '../../bot/src/context/fact-time.mjs';
import { localPackageDeclarations, localPackagePaths, localPathKey, namesLocalPackage } from '../../bot/src/runtime/local-delivery.mjs';
import { activeDuties } from './staffing.mjs';
import { pick } from '../shared/validation.mjs';

const results = 'room-text-results', acceptances = 'room-text-acceptances';
const acceptanceId = (roomId, userMessageId, version) => JSON.stringify([roomId, userMessageId, version]);
const userDelivery = item => !item.observation && !item.routeOnly && !item.teamStaffing && !item.teamIntroduction && !item.roomDutyAction;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const attachmentReads = tools => tools.flatMap(tool => {
  const details = tool.output?.details;
  return tool.status === 'completed' && ['chatroom_read', 'evidence_read'].includes(tool.name) &&
    typeof details?.content === 'string' && details.content && details.reference?.type === 'room' ? [{ ...details, toolId: tool.id }] : [];
});
const matchesPair = (left, right) => left.roomId === right.roomId && left.messageId === right.messageId && left.attachmentId === right.attachmentId;

function completeReferenceRead(reference, reads) {
  const pages = reads.filter(read => read.reviewReference === true && matchesPair(read.reference, reference)).sort((a, b) => a.offset - b.offset);
  const total = pages[0]?.fullCharacters;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const toolIds = [];
  let end = 0;
  for (const { offset, content, fullCharacters, toolId } of pages) {
    if (fullCharacters !== total || !Number.isSafeInteger(offset) || offset < 0 || offset > end || offset + content.length > total) return null;
    if (offset + content.length <= end) continue;
    end = offset + content.length;
    toolIds.push(toolId);
    if (end === total) return { ...reference, toolIds };
  }
  return null;
}

/** A room result points at an actual owner's completed delivery, never a
 * synthetic work, attachment, user instruction, or generated receipt. */
export class RoomTextResults {
  constructor(chatroom) { this.chatroom = chatroom; this.reconciled = new Set(); }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }

  async action(item, task, room, trigger, ownerReply) {
    if (task.status !== 'completed' || task.workId || task.cancelRequested || task.result?.partial ||
        task.result?.suspended || item.observation || item.routeOnly || item.teamStaffing || item.teamIntroduction ||
        trigger.roomId !== room.id || trigger.senderId !== 'user' || !room.members.includes('user')) return null;
    if (item.roomDutyAction) {
      const plan = this.chatroom.dutyActions.current(item, room);
      if (!plan) return null;
      if (plan.gatesProduction && !['waiting', 'paused'].includes(await this.chatroom.dutyActions.coordinatorState(plan))) return null;
      const ownerDelivery = plan.dependency?.condition === OWNER_DELIVERY;
      const existingPublication = plan.dependency?.condition === EXISTING_PUBLICATION;
      const history = reviewReferenceAttachments(plan.dependency);
      let tools = task.tools || [];
      if (ownerDelivery && (ownerReply?.kind !== 'contribution' || !ownerReply.reply)) return null;
      if (ownerDelivery || existingPublication) {
        tools = await this.manager.readState(item.botId, db => {
          const saved = db?.getTask(item.taskId), accepted = saved?.messageId && db.getMessage(saved.messageId);
          if (!saved || saved.id !== task.id || saved.status !== 'completed' || saved.cancelRequested || saved.result?.content !== task.result?.content ||
              accepted?.taskId !== saved.id || accepted.from !== 'controller' || accepted.kind !== 'event' ||
              accepted.metadata?.roomDutyAction !== plan.id || accepted.metadata.originMessageId !== trigger.id ||
              accepted.sourceMessageId !== item.id || accepted.content?.metadata?.deliveryId !== item.id) return null;
          return history.length ? db.listTools(saved.id) : tools;
        });
        if (!tools) return null;
      }
      const used = new Map();
      const publications = plan.publications || [];
      const reads = attachmentReads(tools);
      for (const { reference: ref } of reads) {
        if (ref.roomId === room.id && [...publications, ...(plan.references || [])].some(file =>
          (file.attachmentId || file.id) === ref.attachmentId && file.messageId === ref.messageId))
          used.set(ref.attachmentId, ref);
      }
      if (plan.kind === 'independent-review' && !publications.some(file => used.has(file.id))) return null;
      if (existingPublication && publications.some(file => !used.has(file.id)) ||
          ownerDelivery && plan.grant.relation === 'new' && plan.references?.some(ref =>
            ref.attachmentId && !used.has(ref.attachmentId))) return null;
      const reviewedReferences = history.map(reference => completeReferenceRead(reference, reads));
      if (reviewedReferences.some(reference => !reference)) return null;
      return { kind: plan.kind, sourceUnit: plan.grant.sourceUnit, dependency: plan.dependency, planId: plan.id,
        ...(ownerDelivery ? { workId: plan.workId, operationId: plan.operationId } : {}),
        ...(reviewedReferences.length ? { reviewedReferences } : {}),
        references: [{ type: 'room', roomId: room.id, messageId: trigger.id },
          ...(existingPublication ? [{ type: 'room', roomId: room.id, messageId: plan.dependency.publication.sourceMessageId }] : []),
          ...used.values(), ...reviewedReferences.map(ref => pick(ref, ['type', 'roomId', 'messageId', 'attachmentId']))] };
    }
    const lead = room.team?.leadBotId === item.botId;
    if (task.result?.attachments?.length || task.result?.handoff || !item.routedDutyKey && !(lead && task.tools?.some(tool =>
      tool.name === 'request_decide' && tool.status === 'completed' && tool.output?.details?.roomDeliveryDutyKey))) return null;
    return this.manager.readState(item.botId, db => {
      const saved = db?.getTask(task.id), user = saved && currentUserRequest(saved, db);
      const accepted = user && db.getMessage(user.acceptedMessageId);
      const routing = user && db.getRecord('request-routing', task.id);
      if (saved?.status !== 'completed' || saved.cancelRequested || saved.result?.content !== task.result?.content ||
          routing?.intent !== 'room-deliver' || !routing.roomDeliveryUnits?.length ||
          user.roomId !== room.id || user.messageId !== trigger.id || user.text !== trigger.content ||
          (user.replyTo || null) !== (trigger.replyTo || null) || routing.messageId !== trigger.id || routing.roomId !== room.id ||
          accepted?.sourceMessageId !== item.id || accepted.content?.metadata?.deliveryId !== item.id) return null;
      const singleScope = routing.roomDeliveryUnits.length === 1 && !routing.sourceActions?.length;
      if (lead && (!singleScope || ['ordinary', 'multiple'].includes(item.requestScope))) return null;
      const dutyKey = lead ? routing.roomDeliveryDutyKey : item.routedDutyKey;
      if (lead && item.routedBy && item.requestScope === 'single-duty' && item.routedDutyKey !== dutyKey) return null;
      const duty = activeDuties(room, item.botId).find(duty => duty.dutyKey === dutyKey);
      const originalDuty = item.input?.content?.room?.team?.duties?.find(duty => duty.dutyKey === dutyKey &&
        duty.botId === item.botId && duty.state === 'active');
      if (!duty || lead && (!originalDuty || duty.assignedAt !== originalDuty.assignedAt ||
          Date.parse(duty.assignedAt) > Date.parse(trigger.createdAt))) return null;
      return { kind: 'room-handoff', sourceUnit: routing.roomDeliveryUnits[0], singleScope, dutyKey };
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
    if (job.roomDutyAction || job.botId === room.team?.leadBotId && job.requestScope === 'single-duty' ||
        job.input?.kind !== 'request' || job.input?.metadata?.actor !== 'user' ||
        job.input?.replyTo !== trigger.id || job.input?.content?.trigger?.id !== trigger.id) return null;
    return { id: message.id, roomId: room.id, ownerBotId: job.botId, dutyKey: duty.dutyKey, taskId: job.taskId,
      deliveryId: job.id, sourceMessageId: trigger.id, version: message.id, kind: 'room-handoff', legacyCandidate: true, publishedAt: message.createdAt };
  }

  async verifyOwner(candidate, original, message, legacy = candidate.legacyCandidate === true) {
    if (!original || original.content.length > 4000 || message.content.length > 4000) return false;
    return this.manager.readState(candidate.ownerBotId, db => {
      const task = db?.getTask(candidate.taskId), user = task && currentUserRequest(task, db);
      const accepted = task?.messageId && db.getMessage(task.messageId);
      const routing = user && db.getRecord('request-routing', task.id);
      return task?.status === 'completed' && !task.cancelRequested && !task.result?.partial && !task.result?.suspended &&
        !task.result?.attachments?.length && !task.result?.handoff && task.result?.content?.trim() === message.content &&
        accepted?.sourceMessageId === candidate.deliveryId && accepted.content?.metadata?.deliveryId === candidate.deliveryId &&
        user?.roomId === candidate.roomId && user.messageId === candidate.sourceMessageId && user.text === original.content &&
        routing?.roomId === user.roomId && routing.messageId === user.messageId &&
        (legacy && routing.intent === 'discuss' || routing.intent === 'room-deliver' && routing.roomDeliveryUnits?.length);
    });
  }

  publish(item, task, message, action) {
    if (!action || message.id !== 'reply:' + item.id || message.attachments?.length || message.workId || !message.content) return null;
    if (action.kind === 'room-handoff' && (task.result?.content?.trim() !== message.content ||
        !activeDuties(this.chatroom.need('rooms', item.roomId), item.botId).some(duty => duty.dutyKey === action.dutyKey))) return null;
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

  packageReply(message, room, trigger, requestedPaths) {
    if (!requestedPaths.size || !message?.jobId || message.roomId !== room.id || message.kind === 'error' ||
        message.workId || message.workPublication || message.observationReply || message.attachments?.length ||
        message.id !== 'reply:' + message.jobId || !(Date.parse(message.createdAt) < Date.parse(trigger.createdAt))) return null;
    const packages = localPackageDeclarations(message.content).filter(file => requestedPaths.has(localPathKey(file.path)));
    if (!packages.length) return null;
    const job = this.store.get('deliveries', message.jobId), request = job && this.store.get('messages', job.messageId);
    if (job?.roomId !== room.id || job.status !== 'completed' || !job.taskId || job.workId || !userDelivery(job) ||
        job.botId !== message.senderId || request?.roomId !== room.id || request.senderId !== trigger.senderId ||
        request.id !== message.replyTo || !(Date.parse(request.createdAt) < Date.parse(message.createdAt))) return null;
    return { messageId: message.id, publishedAt: message.createdAt, senderId: message.senderId,
      requestMessageId: request.id, requestedAt: request.createdAt, jobId: job.id, taskId: job.taskId, packages };
  }

  async before(room, trigger) {
    const times = acceptanceClockTimes(trigger.content);
    const requestedPaths = new Set(localPackagePaths(trigger.content).map(localPathKey));
    const replied = trigger.replyTo && this.store.get('messages', trigger.replyTo);
    const messages = !trigger.replyTo || requestedPaths.size && replied?.workPublication
      ? this.chatroom.messages(room.id).reverse() : [replied];
    const candidates = [], attachmentPublications = [], roomWorkPublications = [], roomPackageReplies = [];
    let complete = true;
    let unavailable = false;
    for (const message of messages) {
      const packageReply = this.packageReply(message, room, trigger, requestedPaths);
      if (packageReply) roomPackageReplies.push(packageReply);
      if (trigger.replyTo && message?.id !== trigger.replyTo) continue;
      if (message?.workPublication && message.eventType === 'work_result' && message.roomId === room.id && message.workId &&
          Date.parse(message.createdAt) < Date.parse(trigger.createdAt)) {
        const paths = localPackagePaths(message.content).filter(path => namesLocalPackage(trigger.content, basename(path)));
        const operationIds = (message.sourceRefs || []).filter(ref => ref.type === 'codex').map(ref => ref.operationId);
        if (operationIds.length && (paths.length || requestedPaths.size && message.attachments?.length))
          roomWorkPublications.push({ messageId: message.id, publishedAt: message.createdAt,
            workId: message.workId, senderId: message.senderId, replyTo: message.replyTo, operationIds, paths });
      }
      // Include other senders' attachments in the ambiguity check. Only the
      // owning work's separately verified receipt can authorize a write.
      if (!trigger.replyTo && message?.attachments?.length && Date.parse(message.createdAt) < Date.parse(trigger.createdAt) &&
          times.includes(localTime(message.createdAt)?.slice(11, 16))) {
        attachmentPublications.push({ messageId: message.id, publishedAt: message.createdAt,
          attachments: message.attachments.map(({ id, name }) => ({ id, name })) });
      }
      const record = this.candidate(message, room, trigger);
      if (!record) continue;
      if (candidates.length >= 12 && !times.includes(localTime(message.createdAt)?.slice(11, 16))) { complete = false; continue; }
      const source = this.store.get('messages', record.sourceMessageId);
      if (record.legacyCandidate) {
        const verified = await this.verifyOwner(record, source, message).catch(() => null);
        if (verified === null) unavailable = true;
        if (!verified) continue;
      }
      candidates.push({ ...record, content: message.content.slice(0, 4000), originalRequest: source.content.slice(0, 4000) });
    }
    return { roomResults: candidates, roomResultsComplete: complete && !unavailable,
      attachmentPublications, roomWorkPublications, roomPackageReplies, unavailable };
  }

  toolDecisions(tools, taskId, roomId, messageId) {
    return (tools || []).filter(tool => tool.name === 'request_decide' && tool.status === 'completed')
      .map(tool => tool.output?.details).filter(receipt => receipt?.messageId === messageId && receipt.roomId === roomId &&
        receipt.acceptanceReceiptTaskId === taskId).flatMap(receipt => receipt.roomResultAcceptances || []);
  }

  authenticatedDecisions(db, room, trigger, item) {
    if (!item.taskId || !userDelivery(item) || item.roomId !== room.id || trigger?.roomId !== room.id ||
        item.messageId !== trigger.id || trigger.senderId !== 'user') return [];
    const task = db?.getTask(item.taskId), user = task && currentUserRequest(task, db);
    const accepted = task?.messageId && db.getMessage(task.messageId);
    if (!user || user.roomId !== room.id || user.messageId !== trigger.id || user.text !== trigger.content ||
        (user.replyTo || null) !== (trigger.replyTo || null) || accepted.sourceMessageId !== item.id ||
        accepted.content?.metadata?.deliveryId !== item.id) return [];
    const routing = db.getRecord('request-routing', task.id);
    if (routing?.acceptanceReceiptTaskId !== task.id || routing.roomId !== room.id || routing.messageId !== trigger.id) return [];
    return this.toolDecisions(db.listTools(task.id), task.id, room.id, trigger.id).filter(decision => {
      const id = acceptanceId(room.id, trigger.id, decision.version);
      return !decision.alreadyRecorded && decision.id === id && decision.roomId === room.id && decision.userMessageId === trigger.id &&
        (decision.userId === undefined || decision.userId === user.actor && decision.approvalTaskId === task.id &&
          decision.acceptedMessageId === user.acceptedMessageId) &&
        Array.isArray(decision.clauses) && decision.clauses.length && decision.clauses.every(clause =>
          typeof clause.userClause === 'string' && clause.userClause.trim() && Number.isSafeInteger(clause.clauseStart) &&
          clause.clauseStart >= 0 && user.text.startsWith(clause.userClause, clause.clauseStart)) &&
        same(decision, db.getRecord('room-result-acceptances', id)) && routing.roomResultAcceptances?.some(item => same(item, decision));
    });
  }

  async record(room, trigger, item, task) {
    if (!this.toolDecisions(task.tools, task.id, room.id, trigger.id).length) return [];
    const decisions = await this.manager.readState(item.botId, db => this.authenticatedDecisions(db, room, trigger, item));
    return this.project(room, trigger, item, decisions);
  }

  async reconcile(room) {
    if (this.reconciled.has(room.id)) return;
    const byBot = Map.groupBy(this.chatroom.jobs(room.id).filter(job => job.taskId && job.status === 'completed' && userDelivery(job) &&
      job.input?.metadata?.actor === 'user' && job.input?.kind === 'request'), job => job.botId);
    for (const [botId, jobs] of byBot) {
      const approvals = await this.manager.readState(botId, db => {
        const missing = new Set((db?.listRecords('room-result-acceptances') || []).filter(decision => decision.roomId === room.id &&
          decision.deliveryId === undefined && !this.store.get(acceptances, decision.id)).map(decision => decision.userMessageId));
        return jobs.filter(item => missing.has(item.messageId)).flatMap(item => {
          const trigger = this.store.get('messages', item.messageId);
          return this.authenticatedDecisions(db, room, trigger, item).filter(decision => decision.deliveryId === undefined)
            .map(decision => ({ item, trigger, decision }));
        });
      });
      for (const { item, trigger, decision } of approvals) await this.project(room, trigger, item, [decision]);
    }
    this.reconciled.add(room.id);
  }

  async project(room, trigger, item, decisions) {
    const changes = [];
    for (const decision of decisions) {
      if (this.store.get(acceptances, decision.id)) continue;
      const message = this.store.get('messages', decision.publicationMessageId);
      const candidate = this.candidate(message, room, trigger);
      if (!candidate || candidate.version !== decision.version || candidate.ownerBotId !== decision.ownerBotId ||
          candidate.dutyKey !== decision.dutyKey || candidate.sourceMessageId !== decision.sourceMessageId ||
          candidate.taskId !== decision.taskId || decision.deliveryId !== undefined && candidate.deliveryId !== decision.deliveryId) continue;
      if (candidate.legacyCandidate && decision.legacyRoomDelivery !== true) continue;
      if ((candidate.legacyCandidate || decision.deliveryId === undefined) && (candidate.kind !== 'room-handoff' ||
          !await this.verifyOwner(candidate, this.store.get('messages', candidate.sourceMessageId), message, decision.legacyRoomDelivery === true))) continue;
      this.store.transaction(() => {
        const id = decision.id;
        if (this.store.get(acceptances, id)) return;
        const publication = this.store.get('messages', candidate.id);
        const current = this.candidate(publication, this.chatroom.need('rooms', room.id), trigger);
        if (!current || current.version !== candidate.version || current.taskId !== candidate.taskId || current.deliveryId !== candidate.deliveryId ||
            current.ownerBotId !== candidate.ownerBotId || current.sourceMessageId !== candidate.sourceMessageId ||
            current.dutyKey !== candidate.dutyKey || publication.content !== message.content) return;
        const repeated = this.store.list(acceptances).some(prior => {
          if (prior.roomId !== room.id || prior.version !== decision.version) return false;
          const source = this.store.get('messages', prior.sourceMessageId);
          return source?.roomId === room.id && sameRoomResultAcceptance({ ...prior, userId: source.senderId },
            { ...decision, userId: trigger.senderId });
        });
        if (repeated) return;
        if (current.legacyCandidate) {
          const { legacyCandidate, ...identity } = current;
          this.store.save(results, { ...identity, certifiedByAcceptance: trigger.id });
          this.link(current);
        }
        const record = this.store.save(acceptances, { id, roomId: room.id, resultId: current.id, version: current.version,
          dutyKey: current.dutyKey, ownerBotId: current.ownerBotId, sourceMessageId: trigger.id, userId: trigger.senderId, deliveryId: item.id,
          resultDeliveryId: current.deliveryId, approvalTaskId: item.taskId,
          ...pick(decision, ['scope', 'remainingBoundaries', 'fullScope', 'clauses', 'recordedAt']) });
        changes.push({ key: 'room-acceptance:' + id, kind: 'room-result-acceptance', messageId: trigger.id, resultId: record.resultId });
      });
    }
    return changes;
  }
}
