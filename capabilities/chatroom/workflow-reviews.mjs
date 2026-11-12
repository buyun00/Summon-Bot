import { activeDuties, staffingProject } from './staffing.mjs';
import { workflowReviewerId } from '../../bot/src/context/workflow-review.mjs';
import { now, pick } from '../shared/validation.mjs';

const records = 'workflow-reviews';
const decisions = 'business-decisions';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const interval = 90_000;
const workTopics = /负责|验收|复验|验证|交接|长期|维护|responsib|verif|acceptance|handoff|mainten/i;
const viewMessage = message => ({ ...pick(message, ['id', 'senderId', 'replyTo', 'workId', 'toBotId', 'createdAt']),
  content: message.content.slice(0, 1600),
  attachments: (message.attachments || []).slice(0, 8).map(item => pick(item, ['id', 'name', 'size'])) });
// Length framing keeps distinct sources distinct without reading or hashing any artifact.
const key = (...parts) => parts.map(part => `${String(part || '').length}:${part || ''}`).join('');

export class WorkflowReviews {
  constructor(chatroom) { this.chatroom = chatroom; }
  get store() { return this.chatroom.store; }
  get manager() { return this.chatroom.manager; }
  eligible(room) { return staffingProject(room) && room.members.includes('user') && room.team.leadBotId !== workflowReviewerId; }
  members(room) {
    const bot = this.manager.store.get('bots', workflowReviewerId);
    return this.eligible(room) && bot?.presetId === 'skeptic' ? [...new Set([...room.members, workflowReviewerId])] : room.members;
  }
  seed() {
    if (this.store.get('chatroom-schema', 'workflow-review') || this.manager.store.get('bots', workflowReviewerId)?.presetId !== 'skeptic') return;
    this.store.transaction(() => {
      for (const room of this.store.list('rooms')) {
        const members = this.members(room);
        if (members.length !== room.members.length) this.store.save('rooms', { id: room.id, members });
      }
      this.store.save('chatroom-schema', { id: 'workflow-review', version: 1 });
    });
  }
  available(botId) {
    const bot = this.manager.store.get('bots', botId);
    return bot?.status === 'active' && !bot.archivedAt && (bot.runIntent !== 'stopped' || bot.firstRunPending);
  }
  privateRoom(room, targetBotId) {
    return this.store.list('rooms').find(value => value.kind === 'dm' && value.status === 'active' &&
      value.members.length === 2 && value.members.includes(workflowReviewerId) && value.members.includes(targetBotId) &&
      room.members.includes(targetBotId) && room.members.includes(workflowReviewerId));
  }
  current(review, deliveryRoomId) {
    const room = review && this.store.get('rooms', review.roomId);
    return room && this.eligible(room) && room.members.includes(workflowReviewerId) && room.members.includes(review.targetBotId) &&
      this.available(workflowReviewerId) && this.available(review.targetBotId) &&
      room.goal === review.goal && room.team.requirements === review.requirements && room.team.revision === review.teamRevision &&
      (!deliveryRoomId || deliveryRoomId === room.id || this.privateRoom(room, review.targetBotId)?.id === deliveryRoomId) ? room : null;
  }
  consider(room, message, signal) {
    if (!this.eligible(room) || !room.members.includes(workflowReviewerId) || !this.available(workflowReviewerId) ||
        !signal || message.senderId === workflowReviewerId || message.observationReply) return;
    const parent = message.replyTo && this.store.get('messages', message.replyTo);
    const followup = signal.kind === 'user-update' && parent?.roomId === room.id &&
      parent.senderId !== 'user' && parent.senderId !== 'system' && workTopics.test(message.content);
    const progress = signal.kind === 'work-progress' && workTopics.test(message.content);
    if (!followup && !progress && !['work-result', 'room-result'].includes(signal.kind)) return;
    const targetBotId = followup ? parent.senderId : message.senderId;
    if (targetBotId === workflowReviewerId || !room.members.includes(targetBotId) || !this.available(targetBotId)) return;
    const id = `review:${message.id}`;
    const prior = this.store.get(records, id);
    if (prior) return;
    const recent = this.store.get('workflow-review-cursor', room.id);
    const open = recent && this.store.get(records, recent.reviewId);
    const pending = ['queued', 'asked'].includes(open?.status);
    const capacity = this.chatroom.jobs().filter(job => job.workflowReview && !terminal.has(job.status)).length >= 4;
    const reason = pending ? 'review-in-flight' : capacity ? 'review-capacity' :
      recent && !(open?.sourceKind === 'work-progress' && signal.kind === 'work-result') &&
        Date.now() - Date.parse(recent.updatedAt) < interval ? 'room-cooldown' : null;
    if (reason) {
      this.store.save(decisions, { id, roomId: room.id, botId: workflowReviewerId, messageId: message.id,
        decision: 'skip', runtimeCheck: 'confirmed', facts: { reason, lastReviewId: recent?.reviewId }, result: { status: 'no-action' } });
      return;
    }
    const review = this.store.save(records, { id, roomId: room.id, sourceId: message.id, targetBotId,
      decisionMessageId: followup ? parent.id : message.id, workId: (followup ? parent.workId : message.workId) || null,
      operationId: signal.operationId, sourceKind: signal.kind, goal: room.goal, requirements: room.team.requirements, teamRevision: room.team.revision,
      phase: 'inspect', status: 'queued' });
    this.store.save('workflow-review-cursor', { id: room.id, reviewId: review.id });
    this.chatroom.enqueue(message, workflowReviewerId, { id, workId: null, workflowReview: { id, phase: 'inspect' }, priority: 'background' });
  }
  async snapshot(review, room, deliveryRoom) {
    const decision = this.store.get('messages', review.decisionMessageId), origin = this.store.get('messages', review.sourceId);
    if (decision?.roomId !== room.id || origin?.roomId !== room.id) return null;
    const parent = decision?.replyTo && this.store.get('messages', decision.replyTo);
    const recent = this.chatroom.messages(room.id).filter(message => !message.observationReply &&
      message.senderId !== 'system' && message.createdAt <= (review.questionCreatedAt || origin.createdAt));
    const results = recent.filter(message => this.chatroom.staffingEvidence(message)?.kind === 'work-result').slice(-6);
    const textResults = recent.filter(message => this.chatroom.staffingEvidence(message)?.kind === 'room-result').slice(-3);
    const refs = [...new Map([decision, origin, parent, ...results, ...textResults, ...recent.slice(-5)]
      .filter(message => message?.roomId === room.id).map(message => [message.id, message])).values()];
    const work = review.workId && await this.manager.readState(review.targetBotId, db => {
      const work = db?.getRecord('works', review.workId);
      const request = work?.sources?.find(item => item.roomId === room.id && item.replyTo === decision?.replyTo);
      if (!work || work.botId !== review.targetBotId || !request) return null;
      const bindings = work.bindings?.findLast(item => item.operationId === review.operationId);
      return { ...pick(work, ['id', 'revision', 'status', 'productionStage']), requestMessageId: request.replyTo,
        controlRevision: work.controlRevision || 0, externalStatus: bindings?.status,
        acceptanceRecorded: Boolean(work.acceptance), waitingKind: work.waiting?.kind,
        ...(deliveryRoom.id === room.id && review.phase === 'answer' ? { next: work.checkpoint?.next } : {}) };
    });
    return { id: review.id, originRoomId: room.id, targetBotId: review.targetBotId, decisionMessageId: review.decisionMessageId, sourceId: review.sourceId,
      questionId: review.questionId, topic: review.topic, project: pick(room, ['goal', 'projectMode']),
      teamRequirements: room.team.requirements, leadBotId: room.team.leadBotId,
      duties: activeDuties(room).slice(0, 12).map(item => ({ ...pick(item, ['botId', 'responsibility', 'workIds']),
        independentReview: item.dutyProfile?.independentReview === true })),
      privateAvailable: Boolean(this.privateRoom(room, review.targetBotId)), messages: refs.map(viewMessage), work };
  }
  async input(item, trigger, { requireBoundSource = false } = {}) {
    const review = this.store.get(records, item.workflowReview.id), deliveryRoom = this.chatroom.need('rooms', item.roomId);
    const room = this.current(review, deliveryRoom.id);
    if (!room) return null;
    if (requireBoundSource) {
      const signal = this.chatroom.staffingEvidence(trigger);
      const request = trigger.replyTo && this.store.get('messages', trigger.replyTo);
      if (review.status !== 'queued' || room.status !== 'active' || room.id !== deliveryRoom.id ||
          item.id !== review.id || trigger.roomId !== room.id || trigger.id !== review.sourceId || trigger.id !== review.decisionMessageId ||
          trigger.senderId !== review.targetBotId || !review.workId || review.workId !== trigger.workId ||
          request?.roomId !== room.id || !['work-progress', 'work-result'].includes(review.sourceKind) || signal?.kind !== review.sourceKind)
        return null;
    }
    const metadata = { actor: item.workflowReview.phase === 'inspect' ? 'system' : workflowReviewerId,
      roomId: deliveryRoom.id, originMessageId: trigger.id, sourceType: 'workflow-review',
      workflowReview: item.workflowReview, priority: 'background', toolPolicy: { allowedEffects: [] } };
    const snapshot = await this.snapshot({ ...review, phase: item.workflowReview.phase }, room, deliveryRoom);
    if (!snapshot || !this.current(review, deliveryRoom.id)) return null;
    if (requireBoundSource && (!snapshot.work || ['paused', 'cancelled'].includes(snapshot.work.status))) return null;
    if (item.input) return item.input;
    return { id: item.id, kind: 'event', sessionId: item.id, conversationId: item.id, replyTo: trigger.id,
      metadata, content: { room: pick(deliveryRoom, ['id', 'kind']), trigger: viewMessage(trigger), workflowReview: snapshot,
        metadata: { roomId: deliveryRoom.id, deliveryId: item.id } } };
  }
  async finish(item, task) {
    const review = this.store.get(records, item.workflowReview.id), phase = item.workflowReview.phase;
    const room = this.current(review, item.roomId);
    const settled = (decision, result, extra = {}) => this.store.save(decisions, {
      id: `workflow:${item.id}`, roomId: item.roomId, botId: item.botId, taskId: task.id, messageId: item.messageId,
      workId: review?.workId, decision, runtimeCheck: room ? 'confirmed' : 'blocked', result, ...extra,
    });
    if (!review || !room || task.status !== 'completed' || !task.result?.workflowReview) {
      if (review && !['resolved', 'answered', 'retained'].includes(review.status))
        this.store.save(records, { id: review.id, status: room ? 'unconfirmed' : 'expired', failedTaskId: task.id, error: task.error?.code });
      settled('no-action', { status: room ? 'unconfirmed' : 'expired', code: task.error?.code });
      return;
    }
    const answer = task.result.workflowReview;
    if (phase === 'inspect') {
      if (answer.kind !== 'ask') {
        const status = answer.kind === 'pass' ? 'retained' : 'unconfirmed';
        this.store.save(records, { id: review.id, status, inspectionTaskId: task.id });
        settled(answer.kind === 'pass' ? 'retain' : 'no-action', { status });
        return;
      }
      const issueId = key(room.id, review.targetBotId, review.workId || review.decisionMessageId, answer.topic);
      const earlier = this.store.get('workflow-issues', issueId);
      if (earlier && earlier.reviewId !== review.id) {
        this.store.save('workflow-issues', { id: issueId, latestReviewId: review.id, latestEvidenceIds: answer.evidenceIds });
        this.store.save(records, { id: review.id, status: 'same-issue', earlierReviewId: earlier.reviewId });
        settled('reuse', { status: 'same-issue', earlierReviewId: earlier.reviewId });
        return;
      }
      const privateRoom = answer.channel === 'private' && this.privateRoom(room, review.targetBotId);
      const deliveryRoomId = privateRoom?.id || room.id, questionId = `workflow-question:${review.sourceId}`;
      const refs = answer.evidenceIds.map(messageId => ({ type: 'room', roomId: room.id, messageId }));
      const question = this.chatroom.append(deliveryRoomId, { id: questionId,
        content: `流程复核：${answer.question}${privateRoom ? '' : '\n依据：' + answer.evidenceIds.map(id => `[${id}](#${id})`).join('、')}`,
        toBotId: review.targetBotId, ...(privateRoom ? {} : { replyTo: review.decisionMessageId, sourceRefs: refs }),
        observationReply: true, kind: 'message',
      }, workflowReviewerId, saved => {
        this.store.save(records, { id: review.id, status: 'asked', topic: answer.topic, evidenceIds: answer.evidenceIds,
          questionId, questionCreatedAt: saved.createdAt, deliveryRoomId, inspectionTaskId: task.id, issueId });
        this.store.save('workflow-issues', { id: issueId, reviewId: review.id, questionId });
        this.chatroom.enqueue(saved, review.targetBotId, { id: `workflow-answer:${review.sourceId}`, workId: null,
          workflowReview: { id: review.id, phase: 'answer' }, priority: 'background' });
        return true;
      });
      settled('ask', { status: 'asked', questionId: question.id, channel: privateRoom ? 'private' : 'group' },
        { evidenceIds: answer.evidenceIds, topic: answer.topic });
      return;
    }
    let correction;
    if (answer.kind === 'correct' && item.roomId === room.id) {
      try {
        correction = await this.manager.request(item.botId, `/tasks/${encodeURIComponent(task.id)}/workflow-correction`, {
          method: 'POST', body: JSON.stringify({ reviewId: review.id }) });
      } catch (error) {
        if (error.status !== 409) throw error;
        correction = { outcome: 'needs-user', code: 'WORKFLOW_TARGET_CHANGED' };
      }
    }
    if (!this.current(review, item.roomId)) { settled('no-action', { status: 'expired' }); return; }
    const outcome = correction?.outcome || (answer.kind === 'correct' ? 'needs-user' : answer.kind);
    const content = [answer.reply, outcome === 'corrected' ? '已更新原工作的下一步记录。' :
      outcome === 'needs-user' && answer.kind === 'correct' ? '原工作未改动；进一步调整需沿原工作确认。' : ''].filter(Boolean).join('\n\n');
    const reply = this.chatroom.append(item.roomId, { id: `workflow-reply:${review.sourceId}`, replyTo: review.questionId, content,
      observationReply: true, ...(item.roomId === room.id ? { sourceRefs: answer.evidenceIds.map(messageId => ({ type: 'room', roomId: room.id, messageId })) } : {}),
    }, item.botId, saved => {
      this.store.save(records, { id: review.id, status: 'answered', outcome, answerMessageId: saved.id,
        answerTaskId: task.id, correction, answerEvidenceIds: answer.evidenceIds });
      this.store.save('workflow-issues', { id: review.issueId, outcome, answerMessageId: saved.id });
      return true;
    });
    settled('review-original-decision', { status: outcome, messageId: reply.id, ...correction }, { evidenceIds: answer.evidenceIds });
  }
  expire(item, reason) {
    this.store.save(records, { id: item.workflowReview.id, status: 'expired', reason });
    this.store.save(decisions, { id: `workflow:${item.id}`, botId: item.botId, roomId: item.roomId,
      messageId: item.messageId, decision: 'skip', runtimeCheck: 'blocked', facts: { reason }, result: { status: 'expired' } });
  }
}
