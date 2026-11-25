import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, sameRef } from './contract.mjs';
import { sessionRecords as executionRecords } from './executions.mjs';

export class RoomWork {
  constructor(platform) { this.platform = platform; }

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

  readSources(context) {
    if (!context.session?.origin_room) return [];
    const sources = new Map();
    for (const ref of context.resource_refs ?? []) {
      if (!['event', 'file'].includes(ref.kind) || !this.platform.canReadReference(ref, context)) continue;
      if (ref.kind === 'event') {
        const message = this.platform.store.get('messages', ref.id);
        if (!message) continue;
        sources.set(keyOf(ref.kind, ref.id), { ref });
        for (const file of message.attachments ?? []) {
          const target = { kind: 'file', id: file.id };
          if (this.platform.canReadReference(target, context))
            sources.set(keyOf(target.kind, target.id), { ref: target, name: file.name, source_event: ref.id });
        }
      } else if (!sources.has(keyOf(ref.kind, ref.id))) sources.set(keyOf(ref.kind, ref.id), { ref });
    }
    return [...sources.values()];
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
    const event = platform.exec.clean({
      kind: 'event', type: 'work.tool', id, space: room, roomId: room.id,
      author: { kind: 'platform', id: 'platform' },
      execution: { kind: 'session', id: session.id }, call_ref: { kind: 'call', id: callId },
      source, executor: session.execution_actor, engine: session.engine,
      environment: { ...session.execution_environment, cwd: fact.cwd ?? session.workspace?.path, workspace: session.workspace_ref },
      time: new Date().toISOString(), ...fact,
    });
    platform.deliveries.queueEvent(event, [], true, session.execution_actor?.id);
  }
}
