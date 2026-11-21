import { recordKey, runtimeFailure, runtimeRecords as R, sameRef, now } from '../storage/runtime-records.mjs';

const labels = new Map([
  ['superseded', '原发起人确认已按更新后的要求办结'],
  ['answered_by_other', '原发起人确认已由另一位成员答复'],
  ['completed_privately', '原发起人已确认办结'],
]);

export function resolutionLabel(resolution) { return labels.get(resolution?.reason); }

export function confirmedRoomSend(platform, message) {
  const call = message?.callId && platform.store.get('platform-calls', message.callId);
  return call?.tool === 'send' && call.status === 'completed' && call.origin?.bot_id === message.senderId &&
    sameRef(call.target, message.space) && call.result?.message?.id === message.id ? call : null;
}

// This is a host operation by the original requester. The proof stays in the recipient's inbox.
export async function roomDeliveryResolution(runtime, actor, eventId, botId, input) {
  const { platform } = runtime;
  if (actor.kind !== 'user' || !platform.manager.canConfigure(actor, platform.getBot(botId)))
    throw runtimeFailure('delivery_forbidden', '无权处置此接收者的投递', 403);
  const inbox = await runtime.inbox(botId, { create: false });
  const read = id => platform.room.read({ ref: { kind: 'event', id } }, actor.id);
  const original = read(eventId);
  if (original.senderId !== actor.id || !platform.roomMembers(original.roomId).includes(botId))
    throw runtimeFailure('delivery_forbidden', '仅原消息发起人可处置原房间成员的投递', 403);
  const item = platform.deliveries.deliveriesFor(eventId).find(entry => entry.bot_id === botId);
  const route = inbox?.store.getRecord(R.route, recordKey(eventId, 'observation'));
  const run = route?.run_id && inbox.run(route.run_id);
  const conversation = run && inbox.conversation(run.conversation_id);
  if (!item || conversation?.kind !== 'room' || !sameRef(original.space, conversation.space) || !sameRef(item.event.space, original.space))
    throw runtimeFailure('delivery_not_found', '找不到对应房间及接收者的投递', 404);
  const previous = route.resolution;
  if (!input && !previous) throw runtimeFailure('resolution_not_found', '此投递没有人工结清记录', 404);
  const { reason, reply_id } = input ?? previous;
  if (!labels.has(reason) || typeof reply_id !== 'string' || !reply_id.trim() || reply_id.length > 240)
    throw runtimeFailure('invalid_resolution', '请选择结清原因并指定实际答复的消息 ID', 400);
  const reply = read(reply_id);
  const proofRoom = platform.room.room(reply.roomId, actor.id);
  const call = confirmedRoomSend(platform, reply);
  if (!call || !reply.replyTo || !proofRoom.members.includes(reply.senderId))
    throw runtimeFailure('resolution_unverified', '需要可核实的群成员答复及其已完成的发送回执');
  const question = read(reply.replyTo);
  const sameRoom = reply.roomId === original.roomId;
  const sameRecipient = reply.senderId === botId;
  const followup = question.senderId === actor.id && question.sequence > original.sequence;
  const allowed = reason === 'answered_by_other' ? sameRoom && !sameRecipient && question.id === original.id
    : reason === 'superseded' ? sameRoom && sameRecipient && followup
    : !sameRoom && sameRecipient && followup && proofRoom.mode === 'direct' && proofRoom.members.length === 2;
  if (!allowed || reply.roomId !== question.roomId || reply.sequence <= question.sequence)
    throw runtimeFailure('resolution_scope_mismatch', '答复、原提问、接收者或会话范围与所选处置不符');
  if (previous) {
    if (previous.reason !== reason || previous.reply_id !== reply.id) throw runtimeFailure('resolution_conflict', '此投递已有另一条结清记录');
    if (input) runtime.consumeDeliveries(inbox, [eventId]);
    return previous;
  }
  if (item.status !== 'received' || route.state !== 'pending' || run.state !== 'suspended' ||
      runtime.active.get(conversation.id)?.runId === run.id || !run.route_ids.includes(route.id) || item.wait_refs?.length)
    throw runtimeFailure('delivery_state_changed', '只有已接收且原回合挂起的消息投递可在此结清');
  const resolution = { event_id: eventId, room_id: original.roomId, bot_id: botId, delivery_id: item.id,
    delivery_revision: item.revision ?? 1, run_id: run.id, resolved_by: actor, resolved_at: now(), reason,
    reply_room_id: reply.roomId, question_id: question.id, reply_id: reply.id, replied_by: reply.senderId, send_call_id: call.id };
  inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: resolution.resolved_at, resolution });
  // If the gateway stops between stores, the normal received-delivery reconciler replays this receipt.
  runtime.consumeDeliveries(inbox, [eventId]);
  return resolution;
}
