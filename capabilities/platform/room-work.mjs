import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, sameRef } from './contract.mjs';
import { executionRecords } from '../services/connection-records.mjs';
import { forwardMaterials } from './session-work.mjs';

export class RoomWork {
  constructor(platform) { this.platform = platform; }

  followupRooms(values, context, origin) {
    if (!values?.length) return [];
    const rooms = this.platform.store.list('rooms').filter(room =>
      this.platform.canReadSpace(context.actor, { kind: 'room', id: room.id }, context));
    const selected = new Set();
    for (const value of values || []) {
      const id = idOf(value, 'room');
      const exact = rooms.find(room => room.id === id);
      const matches = exact ? [exact] : typeof value === 'string' ? rooms.filter(room => room.name === value) : [];
      if (matches.length !== 1)
        reject('followup_room_unresolved', 'Resolve the requested Room using find(kind=room). Ask for clarification if its name is ambiguous. No intake change was applied.', 409);
      if (matches[0].id !== origin?.id) selected.add(matches[0].id);
    }
    if (values?.length && !selected.size)
      reject('followup_is_origin', 'This is the original Room, which already handles the work. No other Room was opened. Resolve the requested intake Room before reporting success.', 409);
    return [...selected];
  }

  intakes(session, actor = session.owner) {
    return (session.allowed_followup_rooms || []).filter(id => id !== session.origin_room?.id &&
      this.platform.canReadSpace(actor, { kind: 'room', id })).map(id => ({ id, name: this.platform.store.get('rooms', id).name }));
  }

  canHandOff(message, session, actor, accepted = false) {
    if (!message || !session.origin_room || session.authority_revoked) return false;
    const source = { kind: 'room', id: message.roomId };
    if (!accepted && (!this.platform.isFollowupRoomAllowed(session, source) ||
        !sameRef(session.origin_room, source) && session.acceptance_state !== 'open') ||
        !this.platform.canReadSpace(actor, source) || !this.platform.canReadSpace(actor, session.origin_room)) return false;
    if (session.sharing) {
      const room = this.platform.store.get('rooms', session.space.id);
      if (!room || !room.members.every(id => forwardMaterials(message).every(ref =>
        this.platform.canReadReference(ref, { actor: identity(id) })))) return false;
    }
    return true;
  }

  inputSources(args, context, session, call) {
    const { platform } = this;
    const requested = args.material_sources?.map(id => idOf(id, 'event'));
    const origin = context.origin;
    if (!origin || session.origin_execution?.kind !== 'conversation' || session.owner_conversation_id !== origin.conversation_id ||
        !sameRef(session.owner, context.actor)) {
      if (requested?.length) reject('material_source_forbidden', 'Attach original Room materials from the direct owner of this work.', 403);
      return [];
    }
    const incoming = origin.event_ids.map(id => platform.store.get('messages', id)).filter(Boolean);
    const recoveryId = call.recovery_of ?? (args.recovery_of && idOf(args.recovery_of, 'call'));
    const recovery = recoveryId && platform.store.get(callRecords, recoveryId);
    let ids;
    if (origin.fast_read_forward || args.recovery_of || recovery && !requested) {
      const [first] = recovery?.source_event_ids ?? origin.event_ids;
      const submission = platform.store.get('messages', first);
      ids = [first];
      for (const ref of submission?.references ?? []) {
        if (ref.kind !== 'event') continue;
        const original = platform.store.get('messages', ref.id);
        if (original?.roomId === submission.roomId && (submission.senderId === 'user' || original.senderId === submission.senderId)) ids.push(ref.id);
      }
      if (requested?.some(id => !ids.includes(id))) reject('material_source_mismatch', 'Recover the original material only.', 409);
    } else if (requested) ids = requested;
    else {
      const local = incoming.filter(item => item.roomId === session.origin_room?.id);
      const related = local.filter(item => item.replyTo === session.origin_message_id || item.id === session.origin_message_id);
      ids = related.map(item => item.id);
    }
    if (ids.length > 12) reject('material_source_limit', 'Select up to twelve originals for this input.');
    const originals = [...new Set(ids)].map(id => {
      const message = platform.store.get('messages', id);
      if (!this.canHandOff(message, session, context.actor)) reject('material_source_forbidden', 'The source or its authorized intake is unavailable.', 403);
      if (message.roomId !== session.origin_room.id && !origin.fast_read_forward && !recovery) {
        const forward = platform.calls.forwardsFor(context.actor.id, message.roomId, [id]).get(id);
        const authorized = incoming.some(item => item.senderId === 'user' && (item.replyTo === id ||
          item.references?.some(ref => sameRef(ref, { kind: 'event', id })) || item.content.includes(id)));
        if (forward?.target?.id !== session.id && !authorized)
          reject('material_source_forbidden', 'Select the cross-Room original authorized for this particular work.', 403);
      }
      return id;
    });
    return originals;
  }

  priorMaterialReceipts(session, call, originals) {
    const cover = call.origin?.fast_read_forward || call.recovery_of;
    const enclosed = (cover ? originals.slice(1) : originals).filter(id =>
      this.platform.store.get('messages', id).roomId !== session.origin_room.id);
    if (!enclosed.length) return [];
    const prior = this.materialAttempts(session.id, enclosed, call.id);
    const receipts = new Map();
    for (const attempt of prior) {
      const input = attempt.input_id && this.platform.store.get('platform-inputs', attempt.input_id);
      if (input?.call_id !== attempt.id) continue;
      for (const id of enclosed) {
        if (!receipts.has(id) && attempt.material_source_ids.includes(id)) receipts.set(id, { event_id: id, input_status: input.status,
          call_status: attempt.status });
      }
    }
    return [...receipts.values()];
  }

  materialAttempts(sessionId, ids, except = '') {
    if (!ids.length) return [];
    return this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='platform-calls'
      AND json_extract(data,'$.tool')='send_input' AND json_extract(data,'$.target.id')=? AND id<>?
      AND EXISTS (SELECT 1 FROM json_each(data,'$.material_source_ids') WHERE value IN (SELECT value FROM json_each(?)))
      ORDER BY rowid DESC`).all(sessionId, except, JSON.stringify(ids)).map(row => JSON.parse(row.data));
  }

  sourceFacts(ids) {
    return ids.map(id => {
      const message = this.platform.store.get('messages', id);
      return { event: { kind: 'event', id }, room: { kind: 'room', id: message.roomId },
        room_name: this.platform.store.get('rooms', message.roomId).name, author: message.author ?? identity(message.senderId),
        time: message.createdAt, reply_to: message.replyTo, text: message.content };
    });
  }

  scope(args, context, sharing, space) {
    if (args.private_work && (args.work_room || args.work_source))
      reject('invalid_room_work', 'Private work cannot also publish observations to a Room');
    if (args.private_work) return null;
    const publicReader = sharing?.readers.some(item => item.kind === 'room_members' && item.id === space.id);
    if (sharing && !publicReader && args.work_room)
      reject('invalid_room_work', 'This execution has a specific audience');
    const room = args.work_room ? { kind: 'room', id: idOf(args.work_room, 'room') } : publicReader ? space : null;
    if (!room) {
      if (args.work_source) reject('invalid_room_work', 'A work source requires a Room');
      return null;
    }
    const { platform } = this;
    if (platform.store.get('rooms', room.id)?.mode !== 'group') {
      if (args.work_room) reject('room_work_forbidden', 'Select a group Room for work observations', 403);
      return null;
    }
    const submitter = { actor: identity(context.submitted_by ?? context.actor) };
    const inherited = sameRef(context.session?.project_room, room);
    if (!(inherited ? platform.roomMembers(room.id).includes(context.actor.id) : platform.canReadSpace(context.actor, room, context)) ||
        !platform.canReadSpace(submitter.actor, room, submitter) ||
        sharing && !sameRef(room, space))
      reject('room_work_forbidden', 'Work observations require the actual Room and membership', 403);
    const source = args.work_source ? idOf(args.work_source, 'event') : null;
    const message = source && platform.store.get('messages', source);
    if (source && (message?.roomId !== room.id || !inherited && !platform.canReadReference({ kind: 'event', id: source }, context)))
      reject('room_work_source_forbidden', 'Choose an accessible original message in the work Room', 403);
    return { room, source: message ? { kind: 'event', id: message.id } : null };
  }

  origin(args, context, room, observations) {
    const inherited = context.session?.origin_message_id;
    const explicit = args.origin_message_id && idOf(args.origin_message_id, 'event');
    const observed = sameRef(observations?.room, room) && observations?.source?.id;
    if (inherited && [explicit, observed].some(id => id && id !== inherited))
      reject('invalid_origin_message', 'A direct child inherits its parent Session’s original question', 403);
    if (inherited) return inherited;
    if (observed && explicit && explicit !== observed)
      reject('invalid_origin_message', 'Use the same original question for delegated work and its Room observations');
    const selected = explicit || observed;
    if (selected) {
      if (!room || this.platform.store.get('messages', selected)?.roomId !== room.id ||
          !this.platform.canReadReference({ kind: 'event', id: selected }, context))
        reject('invalid_origin_message', 'Choose an accessible original Room message for origin_message_id', 403);
      return selected;
    }
    if (!room) return null;
    let latestMessage;
    const receiptOrigins = new Set();
    for (const id of context.origin?.event_ids ?? []) {
      const message = this.platform.store.get('messages', id);
      if (message?.roomId === room.id) {
        latestMessage = id;
        continue;
      }
      const event = this.platform.store.get('platform-events', id);
      if (event?.type === 'call.receipt' && event.owner_conversation_id === context.origin.conversation_id &&
          sameRef(event.origin_room, room) && event.origin_message_id) receiptOrigins.add(event.origin_message_id);
    }
    return latestMessage ?? (receiptOrigins.size === 1 ? [...receiptOrigins][0] : null);
  }

  readable(event, context) {
    const { platform } = this;
    const session = platform.store.get(executionRecords, event.execution?.id);
    const work = session?.group_work;
    return Boolean(work && sameRef(work.room, event.space) && platform.canReadSpace(context.actor, work.room, context));
  }

  canPublish(session) {
    const room = session.group_work?.room && this.platform.store.get('rooms', session.group_work.room.id);
    return Boolean(!session.authority_revoked && room && room.members.includes(session.owner.id));
  }

  publish(sessionId, callId, position, fact) {
    const { platform } = this;
    const { store } = platform;
    const session = store.get(executionRecords, sessionId);
    const call = store.get(callRecords, callId);
    if (!session || !this.canPublish(session) || !call ||
        !sameRef(call.target, { kind: 'session', id: session.id })) return;
    const id = keyOf('work.tool', callId, position);
    if (store.get('platform-events', id)) return;
    const { room, source } = session.group_work;
    const event = platform.connections.clean({
      kind: 'event', type: 'work.tool', id, space: room, roomId: room.id,
      author: { kind: 'platform', id: 'platform' },
      execution: { kind: 'session', id: session.id }, call_ref: { kind: 'call', id: callId },
      source, executor: session.execution_actor, connection: { kind: 'connection', id: session.engine },
      environment: { ...session.execution_environment, cwd: fact.cwd ?? session.workspace?.path, workspace: session.workspace_ref },
      time: new Date().toISOString(), ...fact,
    });
    platform.deliveries.queueEvent(event, [], true, session.execution_actor?.id);
  }
}
