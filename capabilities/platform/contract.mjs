export const protocolVersion = 2;

const text = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const flag = { type: 'boolean' };
const value = {};
const oneOf = (...values) => ({ enum: values });
const array = items => ({ type: 'array', items });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const kinds = ['bot', 'room', 'event', 'file', 'session', 'wakeup', 'connection', 'conversation', 'call', 'wait', 'workspace', 'material_consumption'];
const ref = object({ kind: oneOf(...kinds, 'user'), id: text }, ['kind', 'id']);
const principal = { anyOf: [text, object({ kind: oneOf('bot', 'user', 'room_members'), id: text }, ['kind', 'id'])] };
const refOrId = { anyOf: [ref, text] };
const executionRef = object({ kind: oneOf('session', 'conversation'), id: text }, ['kind', 'id']);
const resumeRef = object({ target: object({ kind: oneOf('bot', 'session', 'conversation'), id: text }, ['kind', 'id']), stop_id: text,
  control_version: integer }, ['target', 'stop_id', 'control_version']);
const inputTarget = { anyOf: [
  object({ kind: oneOf('codex_turn'), turn_id: text, request_id: text }, ['kind', 'turn_id']),
  object({ kind: oneOf('pi_run'), run_id: text, request_id: text }, ['kind', 'run_id']),
  object({ kind: oneOf('cli_process'), instance_id: text, launch_call_id: text, request_id: text }, ['kind', 'instance_id', 'launch_call_id']),
  object({ kind: oneOf('service_call'), call_id: text, request_id: text, operation_id: text }, ['kind', 'call_id']),
  object({ kind: oneOf('idle_input'), input_revision: integer }, ['kind', 'input_revision']),
] };
const wakeupRule = { anyOf: [
  object({ kind: oneOf('room_base'), room: refOrId, mode: oneOf('all', 'mentions') }, ['kind', 'room', 'mode']),
  object({ kind: oneOf('event'), room: refOrId, type: text, author: principal, ref }, ['kind', 'type']),
  object({ kind: oneOf('time'), at: text, interval_ms: { type: 'integer', minimum: 1000 }, scope: ref }, ['kind', 'at']),
] };
const model = { anyOf: [refOrId, object({ connection_id: text, id: text,
  thinking_level: oneOf('off', 'low', 'medium', 'high', 'xhigh', 'max') }, ['connection_id']), { type: 'null' }] };

const definitions = [
  ['find', 'Find accessible objects, execution connections, and internal run and call references.',
    object({ kind: oneOf(...kinds), scope: ref, query: text, cursor: text }, ['kind'])],
  ['read', 'Read an accessible object, its history or output, and the available input or control references.',
    object({ ref, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['ref'])],
  ['send', 'Send a message to a Room. Include text, attachments, or shareable references.',
    object({ to: refOrId, text, attachments: array(refOrId), references: array(ref), mentions: array(principal), reply_to: refOrId }, ['to'])],
  ['save_file', 'Save text, a permitted File source, or a relative file from an authorized project directory. Supply the current revision to replace an existing File.',
    object({ space: ref, path: text, content_or_source: { anyOf: [text, object({ text }, ['text']),
      object({ source: object({ kind: oneOf('file'), id: text }, ['kind', 'id']) }, ['source']),
      object({ source: object({ kind: oneOf('workspace'), id: text }, ['kind', 'id']), path: text }, ['source', 'path'])] },
      revision: integer, sources: array(ref) }, ['space', 'path', 'content_or_source'])],
  ['create_bot', 'Create a Bot with instructions and an optional configured default model connection.',
    object({ name: text, instructions: text, model }, ['name', 'instructions'])],
  ['configure_bot', 'Change a Bot configuration at its current revision. An explicit resume reference is required to re-enable a paused Bot. ' +
    'When asked to remember or correct something for future work, read your Bot for its revision, private_space and material_index_ref. ' +
    'If the index reference is empty, use save_file in private_space (for example memory/index.json) to save ordinary JSON such as ' +
    '{"items":[{"id":"stable-note-id","revision":1,"note":"The user’s actual instruction","applies_to":[{"kind":"room","id":"actual-room-id"}],"source_refs":[{"kind":"event","id":"actual-source-event-id"}]}]}. ' +
    'Use the real applicable scope and source references. Register the returned File reference as material_index_ref using the current Bot revision. ' +
    'For an existing index, read it before editing and save with the current File revision. Increment the revision of a changed item.',
    object({ bot: refOrId, revision: integer, name: text, instructions: text, model, enabled: flag, resume_ref: resumeRef,
      material_index_ref: { anyOf: [ref, { type: 'null' }] } }, ['bot', 'revision'])],
  ['create_room', 'Create a Room with the specified members, including you as creator.',
    object({ members: array(principal), title: text }, ['members'])],
  ['configure_room', 'Update the title, membership and pins in one Room revision.',
    object({ room: refOrId, revision: integer, title: text, add_members: array(principal), remove_members: array(principal),
      pin_add: array(ref), pin_remove: array(ref) }, ['room', 'revision'])],
  ['open_session', 'Open an actual Pi or external execution. Explicit sharing requires Room access and a resource scope.',
    object({ engine: refOrId, input: value, workspace: { anyOf: [ref, text] }, space: ref,
      sharing: object({ readers: array(principal), submitters: array(principal), controllers: array(principal) }, ['readers', 'submitters', 'controllers']),
      resource_refs: array(ref) }, ['engine', 'input'])],
  ['send_input', 'Submit input to the actual input target and control version, or resume one explicitly paused execution.',
    object({ target: executionRef, kind: oneOf('reply', 'steer', 'next', 'resume'), control_version: integer, input: value,
      input_target: inputTarget, resume_ref: resumeRef }, ['target', 'kind', 'control_version'])],
  ['stop_session', 'Pause an execution and request actual interruption for the selected scope.',
    object({ target: executionRef, control_version: integer, scope: oneOf('target', 'target_and_owned_calls') }, ['target', 'control_version'])],
  ['set_wakeup', 'Set a Bot’s one Room base subscription, an extra event subscription, or a time reminder.',
    object({ bot: refOrId, event_or_time: wakeupRule, id: text, revision: integer, enabled: flag }, ['bot'])],
];

export const tools = Object.freeze(definitions.map(([name, description, inputSchema]) => Object.freeze({ name, description, inputSchema })));
export const toolNames = Object.freeze(tools.map(tool => tool.name));
const byName = new Map(tools.map(tool => [tool.name, tool]));
export const readTools = new Set(['find', 'read']);
export const user = Object.freeze({ kind: 'user', id: 'user' });

export function reject(code, message, status = 400, details) {
  throw Object.assign(new Error(message), { code, status, details });
}

export function identity(value) {
  if (typeof value === 'string') value = value === user.id ? user : { kind: 'bot', id: value };
  if (!['bot', 'user'].includes(value?.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 256) {
    reject('invalid_identity', 'Invalid principal reference');
  }
  if (value.kind === 'user' && value.id !== user.id) reject('invalid_identity', 'User identity is not available');
  return { kind: value.kind, id: value.id };
}

export const sameIdentity = (left, right) => left?.kind === right?.kind && left?.id === right?.id;
export const sameRef = (left, right) => Boolean(left && right && left.kind === right.kind && left.id === right.id);
export const keyOf = (...parts) => JSON.stringify(parts);

export function idOf(value, kind) {
  if (typeof value === 'string' && value.trim() && value.length <= 512) return value;
  if (value?.kind === kind && typeof value.id === 'string' && value.id.trim() && value.id.length <= 512) return value.id;
  reject('invalid_ref', `Expected a ${kind} reference`);
}

function matches(schema, input) {
  if (schema.anyOf) return schema.anyOf.some(item => matches(item, input));
  if (schema.enum) return schema.enum.includes(input);
  switch (schema.type) {
    case 'object': {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
      return schema.required.every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key =>
        Object.hasOwn(schema.properties, key) && matches(schema.properties[key], input[key]));
    }
    case 'array': return Array.isArray(input) && input.length <= 1000 && input.every(item => matches(schema.items, item));
    case 'integer': return Number.isSafeInteger(input) && input >= schema.minimum && input <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
    case 'string': return typeof input === 'string';
    case 'boolean': return typeof input === 'boolean';
    case 'null': return input === null;
    default: return true;
  }
}

export function validateTool(name, args) {
  const tool = byName.get(name);
  if (!tool) reject('tool_not_found', 'Unknown platform tool', 404);
  if (!matches(tool.inputSchema, args)) reject('invalid_arguments', `Invalid arguments for ${name}`);
}

export function assertRevision(current, supplied, field = 'revision') {
  if (current !== supplied) reject('revision_conflict', `Current ${field} has changed`, 409, { [field]: current });
}

export function page(items, cursor, limit = 50) {
  const index = cursor == null || cursor === '' ? -1 : items.findIndex(item => item.id === cursor);
  if (index === -1 && cursor) reject('cursor_expired', 'The cursor is no longer readable', 409);
  const result = items.slice(index + 1, index + 1 + limit);
  return { items: result, next_cursor: items.length > index + 1 + result.length ? result.at(-1).id : null };
}
