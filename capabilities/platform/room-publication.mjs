import { idOf, reject, sameRef } from './contract.mjs';

export function fieldLayout(materials, presentation, layout) {
  if (!Array.isArray(layout) || !layout.length || layout.length > 100) return;
  const used = new Set(), pieces = [];
  for (const part of layout) {
    if (Number.isInteger(part?.field) && materials[part.field] && !used.has(part.field)) {
      pieces.push(materials[part.field].text);
      used.add(part.field);
    } else if (typeof part?.literal === 'string' && part.literal.length <= 240 &&
        (/^[\s,，、;；|/]*$/u.test(part.literal) || presentation.some(text => text.includes(part.literal)))) {
      pieces.push(part.literal);
    } else return;
  }
  if (used.size === materials.length) return pieces.join('');
}

export function publicationFieldText(release, proposed) {
  if (release.formatted !== undefined) return release.formatted;
  const fields = release.materials.map(item => item.text);
  if (fields.length === 1 && !release.format_literals?.length) return fields[0];
  // Preserve the author's punctuation, line breaks and approved labels/units.
  // Each factual value must occur intact and every gap must be licensed.
  let rest = proposed ?? '';
  const allowedGap = gap => {
    for (const literal of release.format_literals ?? []) gap = gap.split(literal).join('');
    return /^[\s,，、;；|/]*$/u.test(gap);
  };
  for (const field of fields) {
    const at = rest.indexOf(field);
    if (at < 0 || !allowedGap(rest.slice(0, at))) return fields.join(' ');
    rest = rest.slice(at + field.length);
  }
  return allowedGap(rest) ? proposed : fields.join(' ');
}

// Determine the Room of the object actually returned by a read. A directory
// lookup may return several different audiences in a single page.
export function withinPublicationRoom(platform, ref, room, seen = new Set()) {
  if (!ref) return false;
  const { kind, id } = ref;
  const key = JSON.stringify([kind, id]);
  if (seen.has(key)) return false;
  seen.add(key);
  const get = collection => platform.store.get(collection, id);
  if (kind === 'room') return id === room.id;
  if (kind === 'event') {
    const message = get('messages');
    if (message) return message.roomId === room.id;
    const event = get('platform-events');
    if (event?.call_id) return withinPublicationRoom(platform, { kind: 'call', id: event.call_id }, room, seen);
    return sameRef(event?.space, room);
  }
  if (kind === 'session' || kind === 'conversation') {
    const execution = platform.executions.record(ref);
    return sameRef(execution?.origin_room ?? execution?.source_space ?? execution?.space, room);
  }
  if (kind === 'call' || kind === 'wait') {
    const record = get(kind === 'call' ? 'platform-calls' : 'platform-waits');
    return withinPublicationRoom(platform, record?.target, room, seen);
  }
  if (kind === 'file') {
    const file = platform.files.get(id);
    return file ? sameRef(file.space, room) && (file.sources || []).every(source =>
      withinPublicationRoom(platform, source, room, new Set(seen))) : platform.room.attachmentRooms(id).some(item => item.id === room.id);
  }
  if (kind === 'workspace') return platform.store.get('rooms', room.id)?.workspace?.id === id;
  if (kind === 'wakeup') return sameRef(get('platform-wakeups')?.rule?.room, room);
  return ['connection', 'bot', 'user'].includes(kind);
}

export function privateRoomRead(platform, name, args, result, room) {
  if (name === 'read') return !withinPublicationRoom(platform, args.ref, room);
  if (name !== 'find' || args.kind === 'room') return false;
  return (result.items || []).some(item => !withinPublicationRoom(platform,
    item.ref ?? item.execution_ref ?? { kind: args.kind, id: item.id }, room));
}

// A member answering in its own Room can cite a standing release that it
// actually consulted elsewhere. That Room's question cannot grant the release.
export function inspectedPublicationSources(platform, context, destination, calls, requested) {
  const requests = context.origin.event_ids.map(id => platform.store.get('messages', id))
    .filter(item => item?.roomId === destination.id).map(item => ({ id: item.id, text: item.content }));
  if (!requests.length) return null;
  const originals = new Map(), facts = new Map(), factRooms = new Map();
  for (const call of calls.filter(call => call.state === 'completed')) {
    const ref = call.args.ref, result = call.result;
    const messages = call.tool === 'read' && ref?.kind === 'room' ? result?.messages :
      call.tool === 'read' && ref?.kind === 'event' ? [result] :
      call.tool === 'find' && call.args.kind === 'event' ? result?.items : [];
    for (const item of messages || []) {
      if (!item?.roomId || item.roomId === destination.id || originals.has(item.id)) continue;
      const source = platform.store.get('messages', item.id);
      if (source?.roomId !== item.roomId || !platform.canReadReference({ kind: 'event', id: source.id }, context)) continue;
      originals.set(source.id, source);
      facts.set(source.id, source.content);
      factRooms.set(source.id, source.roomId);
    }
  }
  const candidates = [...originals.values()].filter(item => item.senderId === 'user' && (!requested || item.id === requested));
  if (!candidates.length) return null;
  const rooms = new Set(candidates.map(item => item.roomId));
  const hostMessages = new Map([...originals].filter(([,item]) => rooms.has(item.roomId) && item.senderId === 'user'));
  for (const roomId of rooms) {
    const room = { kind: 'room', id: roomId };
    const first = [...hostMessages.values()].filter(item => item.roomId === roomId).map(item => item.createdAt).sort()[0];
    const later = platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.senderId')='user' AND created_at>? ORDER BY rowid`).all(roomId, first);
    for (const { data } of later) {
      const item = JSON.parse(data);
      if (!item.replyTo || originals.has(item.replyTo) || item.content.includes(destination.name) ||
          item.references?.some(ref => ref.kind === 'event' && originals.has(ref.id))) hostMessages.set(item.id, item);
    }
    for (const call of calls) {
      const ref = call.args.ref, result = call.result;
      if (call.tool !== 'read' || call.state !== 'completed' || ref?.kind !== 'file' || result?.id !== ref.id ||
          typeof result.content !== 'string' || !withinPublicationRoom(platform, ref, room) || !platform.canReadReference(ref, context)) continue;
      const file = platform.files.getProjection(ref.id, context).projection;
      if (file.revision === result.revision) {
        const key = JSON.stringify([ref.id, result.revision, call.args.cursor ?? 0]);
        facts.set(key, result.content);
        factRooms.set(key, roomId);
      }
    }
  }
  const host = [...hostMessages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const versionsFor = id => ({ user_messages: host.filter(item => item.roomId === originals.get(id)?.roomId).map(item => item.id),
    results: [], deliveries: [] });
  return { candidates, hostMessages: host, facts, factRooms, versions: { results: [], deliveries: [] }, versionsFor, requests };
}

export function roomQuestionLinks(platform, room, messages) {
  const links = new Set();
  const pending = messages.map(item => item.id);
  while (pending.length) {
    const id = pending.pop();
    if (links.has(id)) continue;
    const message = platform.store.get('messages', id);
    if (message?.roomId !== room.id) continue;
    links.add(id);
    if (message.replyTo) pending.push(message.replyTo);
    if (message.senderId === 'user') for (const ref of message.references ?? []) if (ref.kind === 'event') pending.push(ref.id);
  }
  return links;
}

export function publicationSources(platform, args, context, destination, localRoot) {
  const origin = context.conversation.space;
  const current = context.origin.event_ids.map(id => platform.store.get('messages', id)).filter(item => item?.roomId === origin.id);
  const receipts = context.origin.event_ids.map(id => platform.store.get('platform-events', id))
    .filter(event => event?.type === 'call.receipt' && event.owner_conversation_id === context.conversation.id);
  const roots = roomQuestionLinks(platform, origin, current);
  for (const event of receipts) if (sameRef(event.origin_room, origin)) roots.add(event.origin_message_id);
  const localMessage = localRoot && platform.store.get('messages', localRoot);
  const localLinks = localMessage && roomQuestionLinks(platform, origin, [localMessage]);
  if (localLinks) for (const id of localLinks) roots.add(id);
  const owned = platform.executions.directWork(context.conversation.id).filter(work => sameRef(work.origin_room, origin) &&
    (!localRoot || localLinks?.has(work.origin_message_id)) && (roots.has(work.origin_message_id) || work.owner_run_id === context.origin.run_id));
  const questions = new Set(owned.map(work => work.origin_message_id));
  if (localRoot && !questions.size) return null;
  const requested = args.publication?.authorization && idOf(args.publication.authorization, 'event');
  if (questions.size > 1) {
    const source = requested && platform.store.get('messages', requested);
    const matching = source?.roomId === origin.id ? [...roomQuestionLinks(platform, origin, [source])].filter(id => questions.has(id)) : [];
    if (matching.length !== 1) reject('publication_assignment_required', 'Select the host authorization for the specific original assignment.', 409);
    questions.clear();
    questions.add(matching[0]);
  }
  const messages = new Map(current.map(message => [message.id, message]));
  if (requested && questions.size) {
    const source = platform.store.get('messages', requested);
    if (source?.senderId === 'user' && source.roomId === origin.id &&
        [...roomQuestionLinks(platform, origin, [source])].some(id => questions.has(id))) messages.set(source.id, source);
  }
  for (const root of questions) {
    const question = platform.store.get('messages', root);
    if (question?.roomId === origin.id) messages.set(root, question);
    const replies = platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.replyTo')=? ORDER BY rowid`).all(origin.id, root);
    for (const row of replies) { const reply = JSON.parse(row.data); messages.set(reply.id, reply); }
  }
  const eligible = [...messages.values()].filter(item => item.senderId === 'user');
  const names = platform.store.list('rooms').filter(room => room.members.includes(context.actor.id) && room.name === destination.name);
  const namesDestination = item => item.content.includes(destination.id) || names.length === 1 && item.content.includes(destination.name) ||
    item.references?.some(ref => ref.kind === 'room' && ref.id === destination.id);
  const selected = requested && eligible.find(item => item.id === requested);
  const continuationRoots = selected && roomQuestionLinks(platform, origin, [selected]);
  const candidates = eligible.filter(item => (!requested || requested === item.id || questions.has(item.id) && continuationRoots?.has(item.id)) &&
    (localRoot ? questions.has(item.id) || item.id === requested : namesDestination(item)));
  // A later host message can change or withdraw a deferred grant without
  // replying to the original question. It can restrict this grant, never create it.
  const start = candidates.map(item => item.createdAt).sort()[0];
  if (start && questions.size) {
    const later = platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.senderId')='user' AND created_at>? ORDER BY rowid`).all(origin.id, start);
    for (const { data } of later) {
      const item = JSON.parse(data);
      if (!item.replyTo || namesDestination(item) || item.mentions?.includes(context.actor.id) ||
          [...roomQuestionLinks(platform, origin, [item])].some(id => questions.has(id))) messages.set(item.id, item);
    }
  }
  const hostMessages = [...messages.values()].filter(item => item.senderId === 'user').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const facts = new Map([...messages.values()].map(item => [item.id, item.content]));
  // Only a terminal result of the directly owned work belongs to the source
  // review. Its raw private output never enters the destination Room context.
  const results = [];
  for (const work of owned) {
    if (!questions.has(work.origin_message_id) || work.status !== 'completed' || work.authority_revoked) continue;
    const call = platform.store.get('platform-calls', work.latest_call_id);
    const event = call?.result_ref?.kind === 'event' && platform.store.get('platform-events', call.result_ref.id);
    if (event?.status !== 'completed' || event.target?.id !== work.id || !platform.canReadEvent(event, context)) continue;
    const output = event.result?.output;
    const text = typeof output === 'string' ? output : output?.text;
    if (text) { facts.set(event.id, text); results.push(event.id); }
  }
  const deliveries = new Set();
  const accepted = new Set();
  for (const work of owned.filter(work => questions.has(work.origin_message_id))) {
    for (const { message, stage } of platform.executions.originalReplies(work)) {
      if (['complete', 'correction'].includes(stage) || work.acceptance?.outcome === 'delivered' && work.acceptance.message_id === message.id)
        deliveries.add(message.id);
      if (work.acceptance_state === 'closed' && work.acceptance?.outcome === 'delivered' && work.acceptance.message_id === message.id)
        accepted.add(message.id);
    }
  }
  const versions = { user_messages: hostMessages.map(item => item.id), results, deliveries: [...deliveries], accepted: [...accepted] };
  const confirmed_delivery = deliveries.size > 0;
  return { candidates, hostMessages, facts, versions, current, requested, questions, confirmed_delivery, local_work: Boolean(localRoot) };
}

export function currentPublicationGrant(platform, sources, grant) {
  const issuer = grant && sources?.candidates.find(item => item.id === grant.authorization_id);
  if (!issuer || !grant.materials?.length ||
      JSON.stringify(sources.versionsFor?.(issuer.id) ?? sources.versions) !== JSON.stringify(grant.versions)) return false;
  return grant.materials.every(part => {
    if (sources.factRooms && sources.factRooms.get(part.event_id) !== issuer.roomId) return false;
    const evidence = sources.facts.get(part.event_id);
    if (evidence !== undefined) return evidence.includes(part.text);
    const message = platform.store.get('messages', part.event_id);
    return message?.roomId === issuer.roomId && message.content.includes(part.text);
  });
}

export function publicationSelection(grant) {
  return grant && JSON.stringify([grant.source_room, grant.authorization_id, grant.dispatch_id, grant.fields_only,
    grant.materials.map(part => part.text), grant.presentation, grant.formatted, grant.format_literals]);
}

export function publicationContext(platform, args, context, grant) {
  const origin = context.conversation.space;
  const destination = platform.room.room(idOf(args.to, 'room'), context.actor.id);
  const to = { kind: 'room', id: destination.id };
  const crossRoom = !sameRef(origin, to);
  const inputs = context.origin.event_ids.map(id => platform.store.get('messages', id)).filter(Boolean);
  let release;
  if (crossRoom) {
    if (grant?.review_error) reject('publication_review_incomplete', 'The source authorization review could not finish. The destination has received no message.', 409, { reason: grant.review_error });
    if (grant) {
      const sources = publicationSources(platform, args, context, destination);
      if (currentPublicationGrant(platform, sources, grant)) release = grant;
    }
    if (!release) reject('room_publication_unauthorized',
      'Sending to another Room requires a current instruction from the host naming that destination and what to publish. Reply in the requesting Room or use the authorized Session intake.', 403);
  }
  if (!crossRoom && grant?.source_room) release = grant;
  const replyId = args.reply_to && idOf(args.reply_to, 'event');
  const reply = replyId && platform.store.get('messages', replyId);
  if (replyId && reply?.roomId !== to.id) reject('room_reply_unavailable', 'Choose a reply in the destination Room', 409);
  const attachments = (args.attachments ?? []).map(id => ({ kind: 'file', id: idOf(id, 'file') }));
  if (crossRoom && release.fields_only && (attachments.length || args.references?.length || args.mentions?.length))
    reject('publication_source_unavailable', 'The source authorized a field-only delivery. Send the fields to the named Room.', 403);
  for (const ref of [...attachments, ...(args.references ?? [])]) {
    if (!withinPublicationRoom(platform, ref, to) && !release)
      reject('publication_source_unavailable', 'This reference belongs to a different audience.', 403);
    if (release && (crossRoom || !withinPublicationRoom(platform, ref, to))) {
      const instruction = platform.store.get('messages', release.authorization_id);
      if (!release.materials.some(part => part.event_id === ref.id && platform.store.get('messages', ref.id)?.content === part.text) &&
          !(instruction.attachments?.some(item => ref.kind === 'file' && item.id === ref.id) &&
            release.materials.some(part => part.text.includes(ref.id) || instruction.attachments.some(item => item.id === ref.id && part.text.includes(item.name)))))
        reject('publication_source_unavailable', 'The current user instruction must identify the reference being shared.', 403);
    }
    platform.assertShareable(ref, { actor: context.actor, room: destination, context });
  }
  return { destination: { id: to.id, name: destination.name }, cross_room: crossRoom, release, ...(grant?.review_error && { source_review: grant.review_error }),
    current_message_ids: inputs.filter(item => item.roomId === to.id).map(item => item.id), reply_to: replyId };
}
