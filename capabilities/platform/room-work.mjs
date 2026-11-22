import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, sameRef } from './contract.mjs';
import { executionRecords } from '../services/connection-records.mjs';
import { forwardMaterials } from './session-work.mjs';
import { roomQuestionLinks } from './room-publication.mjs';

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

  intakeSelection(requests, ids, session, actor, room) {
    if (!ids.length || ids.length > 12) return false;
    const witnesses = requests.filter(item => item?.roomId === room.id).map(request => ({
      request, links: request.senderId === 'user' ? roomQuestionLinks(this.platform, room, [request]) : null,
      route: this.platform.runtime.forwardRoute(actor.id, request.id)?.intake_task,
    }));
    return ids.every(id => {
      const source = this.platform.store.get('messages', id);
      if (source?.roomId !== room.id || !this.canHandOff(source, session, actor)) return false;
      const assignment = this.platform.runtime.forwardRoute(actor.id, id)?.intake_task?.session_id;
      if (assignment && assignment !== session.id) return false;
      return witnesses.some(({ request, links, route }) => {
        if (route?.session_id && route.session_id !== session.id) return false;
        if (request.id === id || links?.has(id)) return true;
        if (request.senderId === source.senderId && (request.replyTo === id ||
            request.references?.some(ref => ref.kind === 'event' && ref.id === id) || route?.source_event === id)) return true;
        // A source host can resume a filing thread. A subsequent signed original
        // must reply to that host's request and cite the same author's earlier original.
        return links && links.has(source.replyTo) && this.platform.store.get('messages', source.replyTo)?.senderId === 'user' &&
          source.references?.some(ref => ref.kind === 'event' && links.has(ref.id) &&
            this.platform.store.get('messages', ref.id)?.senderId === source.senderId);
      });
    });
  }

  hostAmendments(session) {
    if (!session.origin_room || !session.origin_message_id) return [];
    return this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.replyTo')=? AND json_extract(data,'$.senderId')='user'
      ORDER BY rowid DESC LIMIT 8`).all(session.origin_room.id, session.origin_message_id).map(row => JSON.parse(row.data)).reverse();
  }

  materialStatus(session, ids, includeReceipt = false) {
    const attempts = this.materialAttempts(session.id, ids);
    return ids.map(id => {
      const attempt = attempts.find(item => !item.material_reference_only && (item.material_action_ids ?? item.material_source_ids).includes(id));
      const input = attempt?.input_id && this.platform.store.get('platform-inputs', attempt.input_id);
      const matched = input && input.call_id === attempt.id && input.target?.id === session.id;
      const terminal = includeReceipt && matched && attempt.result_ref?.kind === 'event' && this.platform.store.get('platform-events', attempt.result_ref.id);
      return { source_event: id, input_status: matched ? input.status : 'unconfirmed',
        ...(attempt && { call_status: attempt.status }), ...(includeReceipt && matched && { input: input.id, submitted_at: input.createdAt,
          ...(terminal?.call_id === attempt.id && terminal.target?.id === session.id && terminal.status === 'completed' &&
            { terminal_result: terminal.id, returned_at: terminal.time }) }) };
    });
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
    if (origin.intake_message_id) {
      const requests = (origin.intake_request_ids ?? [origin.intake_message_id]).map(id => platform.store.get('messages', id));
      ids = origin.intake_material_ids;
      if (!origin.source_room || !this.intakeSelection(requests, ids, session, context.actor, origin.source_room))
        reject('followup_unavailable', 'The selected local originals or receiving work changed.', 409);
    } else if (origin.fast_read_forward || args.recovery_of || recovery && !requested) {
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
      if (args.kind !== 'reply' && related.length) {
        const later = this.hostAmendments(session).filter(item => item.createdAt > related.at(-1).createdAt);
        if (later.length || related.filter(item => item.id !== session.origin_message_id).length > 1)
          reject('material_source_required', 'Retry send_input on this Session. Add material_sources beside target and input, selecting the actual instruction or amendment. Use [] only for an independent instruction.', 409,
            { target: args.target, kind: args.kind, input_target: args.input_target, control_version: args.control_version,
              candidates: [...related, ...later].map(item => ({ id: item.id, time: item.createdAt, text: item.content.slice(0, 240) })) });
      }
      ids = related.map(item => item.id);
    }
    if (ids.length > 12) reject('material_source_limit', 'Select up to twelve originals for this input.');
    const originals = [...new Set(ids)].map(id => {
      const message = platform.store.get('messages', id);
      if (!this.canHandOff(message, session, context.actor)) reject('material_source_forbidden', 'The source or its authorized intake is unavailable.', 403);
      if (message.roomId !== session.origin_room.id && !origin.fast_read_forward && !recovery) {
        const forward = platform.calls.forwardsFor(context.actor.id, message.roomId, [id], session.id).get(id);
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
    const prior = this.materialAttempts(session.id, originals, call.id);
    const receipts = new Map();
    for (const attempt of prior) {
      const input = attempt.input_id && this.platform.store.get('platform-inputs', attempt.input_id);
      if (input?.call_id !== attempt.id || attempt.material_reference_only || this.platform.executions.confirmedNonSubmission(attempt)) continue;
      for (const id of originals) {
        if (!receipts.has(id) && (attempt.material_action_ids ?? attempt.material_source_ids).includes(id)) receipts.set(id, {
          event_id: id, call_id: attempt.id, input_status: input.status, call_status: attempt.status });
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

  receivedOriginals(session, context) {
    const rows = this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='platform-calls'
      AND json_extract(data,'$.target.id')=? AND json_extract(data,'$.tool')='send_input'
      AND json_extract(data,'$.input_id') IS NOT NULL AND json_array_length(data,'$.material_source_ids')>0
      ORDER BY rowid DESC LIMIT 12`).all(session.id);
    const sources = new Map();
    for (const { data } of rows) {
      const call = JSON.parse(data), input = this.platform.store.get('platform-inputs', call.input_id);
      if (input?.call_id !== call.id || call.material_reference_only || this.platform.executions.confirmedNonSubmission(call)) continue;
      for (const id of call.material_action_ids ?? call.material_source_ids) {
        const message = this.platform.store.get('messages', id);
        if (sources.has(id) || !this.canHandOff(message, session, context.actor, true) ||
            !this.platform.canReadReference({ kind: 'event', id }, context)) continue;
        sources.set(id, { id, text: message.content, attachments: message.attachments?.map(file => file.id),
          received_at: call.createdAt, input_status: input.status });
      }
    }
    return [...sources.values()];
  }

  // Expose the owner's native receipts without forwarding material from a
  // different Room. Opening the work and sending it a later input are separate.
  seatReceipts(session, context) {
    if (session.origin_execution?.kind !== 'conversation' || session.owner_conversation_id !== context.conversation?.id ||
        !sameRef(session.owner, context.actor) || !sameRef(session.origin_room, context.conversation.space)) return;
    const { store } = this.platform;
    const initial = store.get(callRecords, session.id);
    const terminal = call => {
      const event = call?.result_ref?.kind === 'event' && store.get('platform-events', call.result_ref.id);
      if (event?.call_id !== call?.id || event?.target?.id !== session.id || event.status !== 'completed') return;
      const output = event.result?.output;
      const text = typeof output === 'string' ? output : output?.text;
      return { id: event.id, time: event.time, has_output: typeof text === 'string' && Boolean(text.trim()) };
    };
    const inputs = store.db.prepare(`SELECT data FROM records WHERE kind='platform-inputs'
      AND json_extract(data,'$.target.id')=? ORDER BY rowid`).all(session.id).flatMap(({ data }) => {
      const input = JSON.parse(data), call = store.get(callRecords, input.call_id);
      if (call?.target?.id !== session.id || call.input_id !== input.id) return [];
      const sources = (call.material_action_ids ?? call.material_source_ids ?? []).map(id => store.get('messages', id)).filter(Boolean);
      const local = sources.filter(message => message.roomId === session.origin_room.id).map(message => message.id);
      return [{ id: input.id, call: call.id, kind: input.kind, status: input.status, time: input.createdAt, local_sources: local,
        ...(call.material_reference_only && { reference_only: true }),
        other_room_sources: sources.length - local.length, terminal: terminal(call)?.id }];
    });
    const received = inputs.filter(input => ['submitted', 'running', 'completed', 'needs_input'].includes(input.status) || input.terminal);
    return { initial_result: initial?.tool === 'open_session' ? terminal(initial) : undefined,
      latest_result: session.latest_call_id ? terminal(store.get(callRecords, session.latest_call_id)) : undefined, native_input_count: inputs.length,
      received_input_count: received.length, original_room_input_count: received.filter(input => input.local_sources.length).length,
      other_room_input_count: received.filter(input => input.other_room_sources).length,
      inputs_without_material_source: received.filter(input => !input.local_sources.length && !input.other_room_sources).length, native_inputs: inputs };
  }

  dispositionHistory(session, context) {
    if (session.origin_execution?.kind !== 'conversation' || session.owner_conversation_id !== context.conversation?.id ||
        !sameRef(session.owner, context.actor) || !sameRef(session.origin_room, context.conversation.space)) return [];
    const inbox = this.platform.runtime.inboxes.get(session.owner.id);
    if (!inbox) return [];
    const localCard = id => {
      const card = typeof id === 'string' && this.platform.store.get('messages', id);
      if (card?.roomId === session.origin_room.id && card.replyTo === session.origin_message_id && card.senderId === session.owner.id) return id;
    };
    const rows = inbox.store.db.prepare(`SELECT id,json_extract(data,'$.args.delivery_message_id') AS requested,
      json_extract(data,'$.args.acceptance_state') AS state, json_extract(data,'$.args.amend_disposition_note') AS amended,
      (json_type(data,'$.args.add_followup_rooms') IS NOT NULL OR json_type(data,'$.args.remove_followup_rooms') IS NOT NULL) AS intake
      FROM records WHERE kind='call' AND json_extract(data,'$.tool')='configure_session'
      AND json_extract(data,'$.conversation_id')=? AND COALESCE(json_extract(data,'$.args.target.id'),json_extract(data,'$.args.target'))=?
      AND (json_extract(data,'$.args.acceptance_state') IS NOT NULL OR amended=1 OR intake=1) ORDER BY rowid`)
      .all(session.owner_conversation_id, session.id);
    return rows.flatMap(row => {
      const call = this.platform.store.get(callRecords, row.id);
      if (!call || call.origin?.conversation_id !== session.owner_conversation_id || call.origin?.bot_id !== session.owner.id) return [];
      const completed = call.status === 'completed' && call.result?.id === session.id;
      if (!completed && call.status !== 'failed') return [];
      const accepted = completed && call.result.acceptance;
      const requested = row.requested?.startsWith('{') ? JSON.parse(row.requested).id : row.requested;
      return [{ call: call.id, time: call.updatedAt, status: call.status, operation: row.amended ? 'amend_note' : row.state ?? 'intake',
        requested_card: localCard(requested), actual_card: localCard(accepted?.message_id ?? call.result?.details?.accepted_card),
        previous_card: localCard(call.delivery_rebind?.previous), outcome: accepted?.outcome,
        ...(row.intake && completed && { followup_room_count: call.result.allowed_followup_rooms?.length }),
        ...(call.status === 'failed' && { error: call.result?.code }) }];
    }).sort((a, b) => a.time.localeCompare(b.time));
  }

  sourceFacts(ids, call) {
    return ids.map(id => {
      const message = this.platform.store.get('messages', id);
      return { event: { kind: 'event', id }, room: { kind: 'room', id: message.roomId },
        room_name: this.platform.store.get('rooms', message.roomId).name, author: message.author ?? identity(message.senderId),
        time: message.createdAt, reply_to: message.replyTo, text: message.content,
        ...(message.attachments?.length && { attachments: message.attachments.map(({ id, name }) => ({ id, name, ref: { kind: 'file', id } })) }),
        ...(message.references?.length && { references: message.references }),
        ...(call && { material_use: call.material_reference_only ? 'reference' :
          call.prior_material_receipts?.some(prior => prior.event_id === id) ? 'previous_input' : 'new_material' }) };
    });
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
