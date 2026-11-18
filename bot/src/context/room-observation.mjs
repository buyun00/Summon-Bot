import { randomUUID } from 'node:crypto';
import { runtimeRecords as R } from '../storage/runtime-records.mjs';
import { contextTokens, eventInput, textMessage } from './projection.mjs';

const eventRef = id => ({ kind: 'event', id });
export const uniqueRefs = refs => [...new Map(refs.map(ref => [JSON.stringify([ref.kind, ref.id]), ref])).values()];

export function observationReadRefs(name, args, result) {
  if (name === 'read') return [args.ref];
  if (name !== 'find') return [];
  return [args.scope, ...(result.items ?? []).map(item => args.kind === 'connection_usage' ? item.connection :
    item.ref ?? item.execution_ref ?? (item.id ? { kind: args.kind, id: item.id } : null))].filter(Boolean);
}

export function canReadObservation(checkpoint, job, view) {
  return checkpoint && job.canRetainAuthorizationView(checkpoint.view_revision, view.view_revision) &&
    checkpoint.access_refs.every(ref => job.canReadReference(ref));
}

export function observationBoundary(platform, job, context, view, state, window, current) {
  const roomId = job.conversation.space.id;
  const room = platform.room.room(roomId, context.actor);
  const sameWindow = window?.generation === state.generation && window.base_checkpoint === (state.checkpoint?.id ?? null);
  const draft = sameWindow && canReadObservation(window.draft, job, view) ? window.draft : null;
  const start = draft?.through ?? state.through;
  const newTrigger = !sameWindow || current.some(event => !window.triggers.includes(event.id));
  const end = newTrigger ? platform.room.observationEnd(roomId, context.actor.id) : window.end;
  const bootstrap = !state.checkpoint && !draft;
  const page = platform.room.observationPage(roomId, context, start?.sequence ?? 0, end, state.work_start, bootstrap ? Infinity : 64);
  const saved = state.checkpoint && job.inbox.store.getRecord(R.checkpoint, state.checkpoint.id);
  const previous = draft || (canReadObservation(saved, job, view) ? saved : null);
  const members = room.members.map(id => {
    if (id === 'user') return { id, kind: 'user' };
    const bot = platform.getBot(id);
    return { id, kind: 'bot', name: bot.name, role: bot.built_in_role?.id };
  });
  return { ...page, roomId, bootstrap, generation: state.generation, base_checkpoint: state.checkpoint?.id ?? null,
    from: state.through, start, end, previous, current, transcript_start: saved?.run_id === job.runId ? saved.transcript_through : 0,
    fact: textMessage({ type: 'room_observation', room: room.id, members, read_through: start,
      previous: previous ? { judgment: previous.text, source_refs: previous.source_refs } : null }) };
}

// The fitted request can omit inputs. Advance only across consecutive, authorized
// originals present in that particular request; remaining pages stay in the same turn.
export function fitObservation(boundary, prompt, budget) {
  const represented = new Map(prompt.flatMap(message => (message.origin_event_ids ?? []).map(id => [id, message])));
  const inputs = [];
  const covered = [];
  let remaining = budget - contextTokens(prompt);
  for (const event of boundary.events) {
    // The common Room prefix already carries each public message or its published summary.
    if (represented.has(event.id)) inputs.push(represented.get(event.id));
    else if (!boundary.bootstrap || event.type !== 'message') {
      const { content, ...original } = event;
      const message = textMessage(eventInput(original, false), Date.parse(event.time));
      const tokens = contextTokens([message]);
      if (tokens > remaining) break;
      remaining -= tokens;
      inputs.push(message);
    }
    covered.push(event);
  }
  const last = covered.at(-1);
  const through = last ? { id: last.id, sequence: last.sequence } : boundary.start;
  const current = boundary.current.filter(event => represented.has(event.id));
  const sources = [...covered, ...current].filter(event => event.result_access !== 'revoked');
  const source_refs = uniqueRefs([...current, covered[0], last].filter(event => event && event.result_access !== 'revoked').map(event => eventRef(event.id)));
  const access_refs = uniqueRefs([...(boundary.previous?.access_refs ?? []),
    ...sources.filter(event => event.type !== 'message' && event.type !== 'pi.input').map(event => eventRef(event.id))]);
  const ordered = new Set([boundary.fact, ...inputs]);
  return { messages: boundary.bootstrap ? [...prompt, ...inputs.filter(message => !prompt.includes(message))]
      : [prompt[0], ...ordered, ...prompt.slice(1).filter(message => !ordered.has(message))],
    through, source_refs, access_refs, event_ids: sources.map(event => event.id),
    more: boundary.more || covered.length < boundary.events.length, advanced: Boolean(covered.length) };
}

export function observedResult(job, boundary, fitted, result, viewRevision) {
  const reads = job.inbox.calls(job.runId).filter(call => call.tool === 'read' && call.state === 'completed')
    .map(call => call.args.ref).filter(ref => job.canReadReference(ref));
  return { room: boundary.roomId, generation: boundary.generation, base_checkpoint: boundary.base_checkpoint,
    from: boundary.from, through: fitted.through,
    checkpoint: { id: randomUUID(), run_id: job.runId, from: boundary.from, through: fitted.through,
      transcript_through: job.inbox.transcript(job.runId).length,
      text: result.text, source_refs: uniqueRefs([...fitted.source_refs, ...reads.filter(ref => ref.kind === 'event')]),
      access_refs: uniqueRefs([...fitted.access_refs, ...reads]), view_revision: viewRevision } };
}
