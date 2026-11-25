import { roleIds } from '../bot-management/roles.mjs';

export const protocolVersion = 3;

const text = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const flag = { type: 'boolean' };
const value = {};
const oneOf = (...values) => ({ enum: values });
const array = items => ({ type: 'array', items });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const kinds = ['bot', 'room', 'event', 'file', 'session', 'wakeup', 'conversation', 'call', 'wait', 'workspace'];
const typedRef = (...types) => object({ kind: oneOf(...types), id: text }, ['kind', 'id']);
const workspaceFileRef = object({ kind: oneOf('workspace_file'), workspace_id: text, path: text }, ['kind', 'workspace_id', 'path']);
const ref = { anyOf: [typedRef(...kinds, 'user'), workspaceFileRef] };
const principal = { anyOf: [text, typedRef('bot', 'user', 'room_members')] };
const refOrId = { anyOf: [ref, text] };
const roomOrId = { anyOf: [typedRef('room'), text] };
const eventOrId = { anyOf: [typedRef('event'), text] };
const references = array(ref);
const secretTarget = object({
  kind: oneOf('hub_login', 'hub_register', 'hub_password', 'env', 'model_api_key', 'file_env', 'session_input'),
  label: text,
  hub_url: text,
  connection_id: text,
  provider: text,
  base_url: text,
  model: text,
  name: text,
  activate: flag,
  workspace: text,
  path: text,
  session_id: text,
  request_id: text,
  control_version: integer,
}, ['kind']);
const promptOption = object({
  id: text,
  label: text,
  description: text,
  recommended: flag,
  tone: oneOf('default', 'primary', 'danger'),
}, ['id', 'label']);
const promptQuestion = object({
  id: text,
  label: text,
  mode: oneOf('single', 'multi', 'text', 'secret'),
  required: flag,
  allow_custom: flag,
  custom_placeholder: text,
  secret: flag,
  field: text,
  env_name: text,
  default_value: text,
  hint: text,
  options: array(promptOption),
}, ['id', 'label', 'mode']);
const messagePrompt = object({
  kind: oneOf('question', 'permission', 'confirm', 'secret'),
  title: text,
  description: text,
  submit_label: text,
  secret_target: secretTarget,
  questions: array(promptQuestion),
});
const promptAnswerItem = object({
  question_id: text,
  label: text,
  selected_ids: array(text),
  selected_labels: array(text),
  custom_text: text,
  redacted: flag,
}, ['question_id']);
const secretDeliveryReceipt = object({
  target_kind: text,
  target_label: text,
  configured_keys: array(text),
  detail: text,
});
const messagePromptResponse = object({
  prompt_message_id: text,
  skipped: flag,
  answers: array(promptAnswerItem),
  secret_delivery: secretDeliveryReceipt,
}, ['prompt_message_id', 'answers']);
const roomMessageFields = {
  text,
  attachments: array(refOrId),
  references,
  mentions: array(principal),
  reply_to: eventOrId,
  for_session_id: text,
  origin_message_id: eventOrId,
  awaiting_reply: flag,
  prompt: messagePrompt,
  prompt_response: messagePromptResponse,
};
const sendMessage = object({ to: roomOrId, ...roomMessageFields }, ['to']);
const executionRef = object({ kind: oneOf('session', 'conversation'), id: text }, ['kind', 'id']);
const subscriptionRules = [
  object({
    kind: oneOf('room_base'),
    room: roomOrId,
    mode: oneOf('all', 'mentions'),
    message_count: { type: 'integer', minimum: 1, description: 'New messages between EggBot observations in this group.' },
  }, ['kind', 'room', 'mode']),
  object({
    kind: oneOf('event'),
    room: roomOrId,
    type: text,
    author: { anyOf: [text, typedRef('bot', 'user'), object({ kind: oneOf('platform'), id: oneOf('platform') }, ['kind', 'id'])] },
    ref,
  }, ['kind', 'type']),
];
const timeFields = {
  at: { ...text, description: 'Due timestamp with time zone.' },
  scope: { ...ref, description: 'Use the Room reference for a reminder about that conversation.' },
};
const interval = { type: 'integer', minimum: 1000 };
const wakeupRule = { anyOf: [
  ...subscriptionRules,
  object({ kind: oneOf('time'), ...timeFields }, ['kind', 'at']),
  object({ kind: oneOf('recurring_time'), ...timeFields, interval_ms: interval }, ['kind', 'at', 'interval_ms']),
] };
const wakeupSelection = { anyOf: [oneOf('new'), object({ id: { ...text, minLength: 1 }, revision: { type: 'integer', minimum: 1 } }, ['id', 'revision'])] };

function wakeupPlatformArgs({ subscription, ...args }) {
  if (args.event_or_time?.kind === 'recurring_time') args.event_or_time = { ...args.event_or_time, kind: 'time' };
  return subscription === 'new' ? args : { ...args, ...subscription };
}

const nullableText = { anyOf: [text, { type: 'null' }] };
const purposeModelOverride = object({ connection_id: text, id: text, thinking_level: nullableText });
const model = { anyOf: [
  refOrId,
  object({ mode: oneOf('follow_default') }, ['mode']),
  object({ mode: oneOf('follow_connection'), connection_id: text }, ['mode', 'connection_id']),
  object({
    mode: oneOf('custom'),
    connection_id: text,
    id: text,
    thinking_level: nullableText,
    purposes: object({ fast_read: purposeModelOverride, conversation: purposeModelOverride, pi_session: purposeModelOverride }),
  }, ['mode', 'connection_id']),
  object({
    connection_id: text,
    id: text,
    thinking_level: nullableText,
    purposes: object({ fast_read: purposeModelOverride, conversation: purposeModelOverride, pi_session: purposeModelOverride }),
  }, ['connection_id']),
  { type: 'null' },
] };

const sessionEngine = { type: 'string', description: 'Execution engine: "pi" (lightweight AI session for research/reading/fallback), "exec" (direct shell or own Bot script), or an enabled work engine id listed in work_engines (e.g. "codex", "claude-code", "grok-build").' };
const sessionWorkspace = { ...text, description: 'A workspace id from find(kind=workspace) or any absolute host directory path (e.g. D:\\Worktrees\\project).' };
const openSessionInput = object({
  engine: sessionEngine,
  input: value,
  workspace: sessionWorkspace,
  space: ref,
  sharing: { anyOf: [flag, object({ readers: array(principal), submitters: array(principal), controllers: array(principal) }, ['readers', 'submitters', 'controllers'])] },
  resource_refs: array(ref),
  work_room: refOrId,
  work_source: refOrId,
  origin_message_id: eventOrId,
  work_summary: text,
  private_work: flag,
}, ['engine', 'input']);
const publicOpenSessionInput = { ...openSessionInput, properties: { ...openSessionInput.properties, workspace: { anyOf: [ref, text] } } };
const configureSessionInput = object({ target: refOrId, work_summary: text }, ['target']);

const definitions = [
  ['find', 'Find accessible objects (bot, room, event, file, session, wakeup, conversation, call, wait, workspace) or bundled_bot templates.',
    object({ kind: oneOf(...kinds, 'bundled_bot'), scope: ref, query: text, cursor: text }, ['kind'])],
  ['read', 'Read an accessible object, its history/output, a workspace directory/file, or a file inside a Bot folder (pass {kind:"bot",id:"<bot-id>"} with path:"instructions.md" | "skills/..." | "scripts/..." | ".local/memory/...").',
    object({ ref, path: text, directory: text, revision: { type: 'integer', minimum: 1 }, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['ref'])],
  ['send', 'Publish to a Room using message:{to:{kind:"room",id},text}, with optional attachments, references, mentions, reply_to, for_session_id, origin_message_id, awaiting_reply, or an interactive prompt card (prompt:{kind:"question"|"permission"|"confirm"|"secret",title?,description?,submit_label?,secret_target?:{...},questions:[...]}). Whenever asking for passwords, API keys, or tokens, ALWAYS use prompt with kind:"secret" and an appropriate secret_target so secrets go directly to host storage without passing through chat history.',
    object({ message: sendMessage }, ['message']), ({ message }) => message],
  ['save_file', 'Save text or a File source into a Room, Workspace directory, or Bot folder. For a Bot folder ({kind:"bot",id:"<bot-id>"}), write portable knowledge to skills/<name>.md, scripts to scripts/<name>.mjs, instructions to instructions.md, or private local notes to .local/memory/<name>.md.',
    object({
      space: ref,
      path: text,
      content_or_source: { anyOf: [
        text,
        object({ text }, ['text']),
        object({ source: object({ kind: oneOf('file'), id: text }, ['kind', 'id']) }, ['source']),
        object({ source: object({ kind: oneOf('workspace'), id: text }, ['kind', 'id']), path: text }, ['source', 'path']),
      ] },
      revision: integer,
      sources: array(ref),
    }, ['space', 'path', 'content_or_source'])],
  ['create_bot', 'Create a standalone Bot folder (with name, public_duty, instructions, optional model, role_id, env_slots) OR activate a bundled Bot package directly via bundled_id (e.g. "codex", "grok-build", "claude-code").',
    object({ name: text, public_duty: text, instructions: text, model, role_id: oneOf(...roleIds), bundled_id: text, env_slots: array(text) })],
  ['configure_bot', 'Update a Bot configuration at its current revision (name, public_duty, instructions, model, enabled, role_id, env_slots).',
    object({
      bot: refOrId,
      revision: integer,
      name: text,
      public_duty: text,
      instructions: text,
      model,
      enabled: flag,
      role_id: oneOf(...roleIds, null),
      env_slots: array(text),
    }, ['bot', 'revision'])],
  ['create_room', 'Create a Room with the specified members. Regular group Rooms automatically include the group lead Bot and EggBot, and can bind one writable project workspace. Supply concise AI-summarized title and lead_name when creating a group explicitly, or pass auto_title:true so the group lead AI summarizes both.',
    object({ members: array(principal), title: text, mode: oneOf('group', 'direct'), workspace: refOrId, lead_name: text, skip_welcome: flag, auto_title: flag }, ['members'])],
  ['configure_room', 'Update the title, membership, pins, or project workspace in one Room revision.',
    object({ room: refOrId, revision: integer, title: text, workspace: { anyOf: [ref, text, { type: 'null' }] }, add_members: array(principal), remove_members: array(principal), pin_add: array(ref), pin_remove: array(ref) }, ['room', 'revision'])],
  ['open_session', 'Open an async background Session. Set engine:"pi" for a lightweight Pi AI session, engine:"exec" to run a shell command ({shell, env?}) or own Bot script ({script:"scripts/xxx.mjs", bot?, args?, protocol?:"summon-jsonl", payload?, env?}), OR an enabled work engine id from work_engines (e.g. "codex", "claude-code", "grok-build") with input as a task string or {text, model?, effort?, sandbox?, approvalPolicy?, extraArgs?}. Pass a concise Chinese work_summary (6–24 chars). When wait_ref is registered, end your turn silently and deliver one concise reply once the completion receipt arrives.',
    openSessionInput],
  ['configure_session', 'Update work_summary on a Session.',
    configureSessionInput],
  ['send_input', 'Send reply (with optional request_id), steer (mid-run adjustment), or next (follow-up turn) directly to a Session or Conversation.',
    object({ target: executionRef, kind: oneOf('reply', 'steer', 'next'), input: value, request_id: text, control_version: integer }, ['target', 'kind'])],
  ['stop_session', 'Interrupt the current in-flight run, turn, or process for the selected scope.',
    object({ target: executionRef, control_version: integer, scope: oneOf('target', 'target_and_owned_calls') }, ['target'])],
  ['set_wakeup', 'Create or update an event subscription or time reminder.',
    object({ bot: { anyOf: [typedRef('bot'), text] }, subscription: wakeupSelection, event_or_time: wakeupRule, enabled: flag }, ['bot', 'subscription']), wakeupPlatformArgs],
  ['configure_workspace', 'Register, update, or delete a local host workspace directory.',
    object({ id: text, revision: integer, name: text, path: text, write: flag, remove: flag })],
  ['manage_hub', 'Inspect or manage this computer’s connection to the Summon Cloud Relay Hub.',
    object({ action: oneOf('status', 'login', 'register', 'disconnect', 'rename_node', 'delete_node'), username: text, password: text, invite_code: text, display_name: text, node_name: text, hub_url: text, node_id: text }, ['action'])],
];

export const tools = Object.freeze(definitions.map(([name, description, inputSchema, toPlatformArgs]) =>
  Object.freeze({ name, description, inputSchema, toPlatformArgs })));
export const toolNames = Object.freeze(tools.map(tool => tool.name));
const byName = new Map(tools.map(tool => [tool.name, tool]));
const runtimeInputs = new Map([
  ['send', object({ to: roomOrId, ...roomMessageFields }, ['to'])],
  ['set_wakeup', object({ bot: refOrId, event_or_time: { anyOf: [...subscriptionRules, object({ kind: oneOf('time'), ...timeFields, interval_ms: interval }, ['kind', 'at'])] }, id: text, revision: integer, enabled: flag }, ['bot'])],
  ['open_session', publicOpenSessionInput],
]);
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
      return (schema.required || []).every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key =>
        schema.properties && Object.hasOwn(schema.properties, key) ? matches(schema.properties[key], input[key]) : schema.additionalProperties === true);
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
  const schema = runtimeInputs.get(name) ?? tool.inputSchema;
  if (!matches(schema, args)) reject('invalid_arguments', `Invalid arguments for ${name}`);
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
