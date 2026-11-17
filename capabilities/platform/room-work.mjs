import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, sameRef } from './contract.mjs';
import { executionRecords } from '../services/connection-records.mjs';

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
    if (!platform.canReadSpace(context.actor, room, context) || !platform.canReadSpace(submitter.actor, room, submitter) ||
        sharing && !sameRef(room, space))
      reject('room_work_forbidden', 'Work observations require the actual Room and membership', 403);
    const source = args.work_source ? idOf(args.work_source, 'event') :
      context.origin?.event_ids?.findLast(id => platform.store.get('messages', id)?.roomId === room.id);
    const message = source && platform.store.get('messages', source);
    if (source && (message?.roomId !== room.id || !platform.canReadReference({ kind: 'event', id: source }, context)))
      reject('room_work_source_forbidden', 'Choose an accessible original message in the work Room', 403);
    return { room, source: message ? { kind: 'event', id: message.id } : null };
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
