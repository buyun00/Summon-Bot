import { roleIds } from '../../roles/index.mjs';

export const protocolVersion = 3;
export const repairRequestType = 'connection.repair.request';
export const repairResultType = 'connection.repair.result';

const text = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const flag = { type: 'boolean' };
const value = {};
const oneOf = (...values) => ({ enum: values });
const array = items => ({ type: 'array', items });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const kinds = ['bot', 'room', 'event', 'file', 'session', 'wakeup', 'connection', 'conversation', 'call', 'wait', 'workspace'];
const typedRef = (...types) => object({ kind: oneOf(...types), id: text }, ['kind', 'id']);
const workspaceFileRef = object({ kind: oneOf('workspace_file'), workspace_id: text, path: text }, ['kind', 'workspace_id', 'path']);
const ref = { anyOf: [typedRef(...kinds, 'user'), workspaceFileRef] };
const principal = { anyOf: [text, typedRef('bot', 'user', 'room_members')] };
const refOrId = { anyOf: [ref, text] };
const roomOrId = { anyOf: [typedRef('room'), text] };
const eventOrId = { anyOf: [typedRef('event'), text] };
const references = array(ref);
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
  mode: oneOf('single', 'multi', 'text'),
  required: flag,
  allow_custom: flag,
  custom_placeholder: text,
  options: array(promptOption),
}, ['id', 'label', 'mode']);
const messagePrompt = object({
  kind: oneOf('question', 'permission', 'confirm'),
  title: text,
  submit_label: text,
  questions: array(promptQuestion),
}, ['questions']);
const promptAnswerItem = object({
  question_id: text,
  label: text,
  selected_ids: array(text),
  selected_labels: array(text),
  custom_text: text,
}, ['question_id']);
const messagePromptResponse = object({
  prompt_message_id: text,
  skipped: flag,
  answers: array(promptAnswerItem),
}, ['prompt_message_id', 'answers']);
const roomMessageFields = { text, attachments: array(refOrId), references, mentions: array(principal), reply_to: eventOrId,
  for_session_id: text, origin_message_id: eventOrId, awaiting_reply: flag, prompt: messagePrompt, prompt_response: messagePromptResponse };
const repairMessageFields = { to: typedRef('connection'), text, references };
const repairOutcome = oneOf('repaired', 'blocked', 'need_info');
const sendMessage = { anyOf: [
  object({ to: roomOrId, ...roomMessageFields }, ['to']),
  object({ ...repairMessageFields, repair_key: text }, ['to', 'text']),
  object({ ...repairMessageFields, reply_to: eventOrId, repair_outcome: repairOutcome }, ['to', 'text', 'reply_to']),
] };
const usagePeriod = { anyOf: [oneOf('yesterday', 'today', '7d'), object({ from: text, to: text }, ['from', 'to'])] };
const executionRef = object({ kind: oneOf('session', 'conversation'), id: text }, ['kind', 'id']);
const inputTarget = { anyOf: [
  object({ kind: oneOf('codex_turn'), turn_id: text, request_id: text }, ['kind', 'turn_id']),
  object({ kind: oneOf('pi_run'), run_id: text, request_id: text }, ['kind', 'run_id']),
  object({ kind: oneOf('cli_process'), instance_id: text, launch_call_id: text, request_id: text }, ['kind', 'instance_id', 'launch_call_id']),
  object({ kind: oneOf('service_call'), call_id: text, request_id: text, operation_id: text }, ['kind', 'call_id']),
  object({ kind: oneOf('idle_input'), input_revision: integer }, ['kind', 'input_revision']),
] };
const subscriptionRules = [
  object({ kind: oneOf('room_base'), room: roomOrId, mode: oneOf('all', 'mentions'),
    message_count: { type: 'integer', minimum: 1, description: 'New messages between EggBot observations in this group. The default is 20.' } }, ['kind', 'room', 'mode']),
  object({ kind: oneOf('event'), room: roomOrId, type: text,
    author: { anyOf: [text, typedRef('bot', 'user'), object({ kind: oneOf('platform'), id: oneOf('platform') }, ['kind', 'id'])],
      description: 'Optional event publisher. work.tool is published by platform.' },
    ref: { ...ref, description: 'For work.tool, use the observed work.tool event reference to follow that execution in its Room. A readable session or call reference can also select that session or call.' },
  }, ['kind', 'type']),
];
const timeFields = { at: { ...text, description: 'Due timestamp with time zone.' },
  scope: { ...ref, description: 'Use the Room reference for a reminder about that conversation.' } };
const interval = { type: 'integer', minimum: 1000 };
const wakeupRule = { anyOf: [...subscriptionRules,
  object({ kind: oneOf('time'), ...timeFields }, ['kind', 'at']),
  object({ kind: oneOf('recurring_time'), ...timeFields, interval_ms: interval }, ['kind', 'at', 'interval_ms']),
] };
const wakeupSelection = { anyOf: [oneOf('new'), object({
  id: { ...text, minLength: 1 }, revision: { type: 'integer', minimum: 1 },
}, ['id', 'revision'])] };

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
  object({ mode: oneOf('custom'), connection_id: text, id: text, thinking_level: nullableText,
    purposes: object({ fast_read: purposeModelOverride, conversation: purposeModelOverride, pi_session: purposeModelOverride }) }, ['mode', 'connection_id']),
  object({ connection_id: text, id: text, thinking_level: nullableText,
    purposes: object({ fast_read: purposeModelOverride, conversation: purposeModelOverride, pi_session: purposeModelOverride }) }, ['connection_id']),
  { type: 'null' },
] };
const sessionEngine = { ...text, description: 'The connection id returned by find with kind connection. Use pi to open a Pi Session.' };
const sessionWorkspace = { ...text, description: 'A workspace id from find(kind=workspace) or any absolute host directory path (e.g. D:\\Worktrees\\project). Use the value itself as text.' };
const openSessionInput = object({ engine: sessionEngine, input: value, workspace: sessionWorkspace, space: ref,
  sharing: { anyOf: [flag, object({ readers: array(principal), submitters: array(principal), controllers: array(principal) }, ['readers', 'submitters', 'controllers'])] },
  resource_refs: array(ref), work_room: refOrId, work_source: refOrId, origin_message_id: eventOrId, work_summary: text,
  private_work: flag, include_execution_guide: flag }, ['engine', 'input']);
const publicOpenSessionInput = { ...openSessionInput, properties: { ...openSessionInput.properties, engine: refOrId, workspace: { anyOf: [ref, text] } } };
const configureSessionInput = object({ target: refOrId, work_summary: text, waiting_summary: nullableText }, ['target']);

const definitions = [
  ['find', 'Find accessible objects, execution connections, and internal run and call references. EggBot can search the team directory by name or public duty. Use a Room scope for its members. ' +
    'Use connection_usage for call counts by date, connection, method and outcome. Filter by room, connection or session with scope. ' +
    'Set period to yesterday (default), today, 7d, or {from,to} with timestamps and offsets.',
    object({ kind: oneOf(...kinds, 'connection_usage'), scope: ref, query: text, cursor: text, period: usagePeriod }, ['kind'])],
  ['read', 'Read an accessible object, its history or output, and the available input or control references. For a workspace or any local host directory (pass {kind:"workspace",id:"D:\\\\..."} directly, including a drive root), use directory "." or a subdirectory to list entries, or add a relative path to read a text file. Read a File ref to inspect its text or image (on vision-capable models); pass an optional revision to inspect a historical snapshot from platform-file-revisions. ' +
    'Use it for a specific observation; do not re-read an unchanged file or Session page already observed in this run unless its revision or status may have changed or you need a different cursor. A registered wait_ref delivers the terminal receipt or an input request to your run automatically.',
    object({ ref, path: text, directory: text, revision: { type: 'integer', minimum: 1 }, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['ref'])],
  ['send', 'Publish to a Room using message:{to:{kind:"room",id},text}, with optional attachments, references, mentions, reply_to, for_session_id, origin_message_id, awaiting_reply, or an interactive prompt card (prompt:{kind:"question"|"permission"|"confirm",title?,submit_label?,questions:[{id,label,mode:"single"|"multi"|"text",required?,allow_custom?,custom_placeholder?,options?:[{id,label,description?,recommended?,tone?}]}]}). Use prompt whenever asking the user to pick options, confirm permissions, or answer structured questions instead of printing numbered text lists. ' +
    'For a verified connection fault, address the message to {kind:"connection",id} with the problem and shareable references. ' +
    'Reuse repair_key when requesting repair of the same fault. The maintainer replies to the repair event on that connection with reply_to and an optional repair_outcome (repaired, blocked, or non-terminal need_info to request missing parameters without closing).',
    object({ message: sendMessage }, ['message']), ({ message }) => message],
  ['save_file', 'Save text, a permitted File source, or a relative file from any local host directory. Supply the current revision to replace an existing File. To write text or copy a shared attachment into a local directory, set space to {kind:"workspace",id:"<workspace-id-or-absolute-path>"} and path to a relative file name. Use the revision from read to detect concurrent edits.',
    object({ space: ref, path: text, content_or_source: { anyOf: [text, object({ text }, ['text']),
      object({ source: object({ kind: oneOf('file'), id: text }, ['kind', 'id']) }, ['source']),
      object({ source: object({ kind: oneOf('workspace'), id: text }, ['kind', 'id']), path: text }, ['source', 'path'])] },
      revision: integer, sources: array(ref) }, ['space', 'path', 'content_or_source'])],
  ['create_bot', 'Create a Bot with private instructions, public_duty for team directory searches, an optional authorized model connection, and an optional built-in duty (role_id). ' +
    'For dedicated maintenance, pass catalog-maintainer and the exact role_connection_id and connection_revision from read to bind it atomically with full maintenance and bound-workspace authority.',
    object({ name: text, public_duty: text, instructions: text, model, role_id: oneOf(...roleIds), role_connection_id: text, connection_revision: integer }, ['name', 'instructions'])],
  ['configure_bot', 'Change a Bot configuration at its current revision. Set enabled:false to pause a Bot or enabled:true to re-enable it. ' +
    'When asked to remember or correct something for future work, read your Bot for its revision, private_space and material_index_ref. ' +
    'If the index reference is empty, use save_file in private_space (for example memory/index.json) to save ordinary JSON such as ' +
    '{"items":[{"id":"stable-note-id","revision":1,"note":"The user’s actual instruction","applies_to":[{"kind":"room","id":"actual-room-id"}],"source_refs":[{"kind":"event","id":"actual-source-event-id"}]}]}. ' +
    'Use the real applicable scope and source references. Register the returned File reference as material_index_ref using the current Bot revision. ' +
    'For an existing index, read it before editing and save with the current File revision. Increment the revision of a changed item and retain source references. ' +
    'When asked to consolidate or update a target knowledge File (such as a Room handbook), read the target File and call save_file directly on it with the updated content, current revision, and source message references in sources. ' +
    'Set role_id to select a built-in duty, or null to clear it. The host selects the tool-onboarding duty. User instructions are a separate setting.',
    object({ bot: refOrId, revision: integer, name: text, public_duty: text, instructions: text, model, enabled: flag,
      role_id: oneOf(...roleIds, null), role_connection_id: text, connection_revision: integer,
      material_index_ref: { anyOf: [ref, { type: 'null' }] } }, ['bot', 'revision'])],
  ['create_room', 'Create a Room with the specified members, including you as creator. Regular group Rooms automatically include the group lead Bot (created synchronously), EggBot, and the tool-onboarding Bot, and can bind one writable project workspace shared by current members.',
    object({ members: array(principal), title: text, mode: oneOf('group', 'direct'), workspace: refOrId, lead_name: text, skip_welcome: flag }, ['members'])],
  ['configure_room', 'Update the title, membership, pins or project workspace in one Room revision. Any member can bind a workspace id or absolute host directory path (auto-registered as a workspace) or set workspace:null to unbind.',
    object({ room: refOrId, revision: integer, title: text, workspace: { anyOf: [ref, text, { type: 'null' }] }, add_members: array(principal), remove_members: array(principal),
      pin_add: array(ref), pin_remove: array(ref) }, ['room', 'revision'])],
  ['open_session', 'Open a Pi or external execution. For a private Session from a Room conversation, omit space and sharing. ' +
    'For engine, use the id string returned by find with kind connection, including pi for a Pi Session. ' +
    'For an external Codex connection, inspect recommended_combinations from read(connection) and pick a (model, effort) pair matching task difficulty unless the user specifies otherwise. Codex defaults to sandbox:"danger-full-access" and approval_policy:"never"; pass sandbox or approval_policy in input when the user asks for another policy. ' +
    'Pi and native executions default to their originating group’s bound workspace, or you can pass any registered workspace id or absolute host directory path directly as workspace. ' +
    'A private initialization can omit workspace to use its selected directory for a native CLI Session. ' +
    'To share the Session, set space to an accessible Room, specify sharing.readers, sharing.submitters and sharing.controllers, ' +
    'and pass resource_refs. The bound group workspace and the selected external engine are included automatically. Include other directory grants explicitly. ' +
    'For work submitted on behalf of a Room, pass work_room and optionally the original Room message as work_source. This authorizes bounded tool observations in that Room and keeps the Session’s own permissions. ' +
    'For work to remain private, omit work_room or explicitly set private_work on a shared Session. ' +
    'Pass a concise Chinese work_summary (6–24 chars describing the live action, e.g. "fetch 比对远程分支差异", shown directly in the live status dock above the composer) and optionally origin_message_id (defaults to the current Room question). ' +
    'Set include_execution_guide to append the installed Summon adapter guide to a text input. ' +
    'When the result registers a wait_ref, end the current turn silently without sending a separate "working on it" chat message—the UI status dock already shows your live progress; send your concise conclusion once the receipt arrives.',
    openSessionInput],
  ['configure_session', 'Update work_summary or waiting_summary on a Session. Sessions settle naturally upon terminal receipts without manual closure ceremonies.',
    configureSessionInput],
  ['send_input', 'Submit input to an execution. For next or steer, control_version and input_target are optional and resolve automatically to the current target when omitted. ' +
    'For a native reply to a specific question/approval, supply input_target with request_id and the answer. ' +
    'A registered wait_ref returns the asynchronous receipt to your run.',
    object({ target: executionRef, kind: oneOf('reply', 'steer', 'next'), control_version: integer, input: value,
      input_target: inputTarget }, ['target', 'kind'])],
  ['stop_session', 'Interrupt the current in-flight run, turn, or tool call for the selected scope. Detaches immediately so the Session stays ready for new input.',
    object({ target: executionRef, control_version: integer, scope: oneOf('target', 'target_and_owned_calls') }, ['target'])],
  ['set_wakeup', 'Create an event subscription or time reminder with subscription:"new" and event_or_time. The platform returns its ID and revision. ' +
    'To change an existing subscription (including a Room base), find or read the wakeup and pass subscription:{id,revision} with its current values, then the new rule or enabled flag. ' +
    'Use kind:"time" for a single reminder. Choose kind:"recurring_time" and an interval only for an explicitly repeating reminder. ' +
    'To follow one published job, use kind:"event", type:"work.tool", its Room, and ref:{kind:"event",id} from a visible work.tool observation. Read the status and output on delivery.',
    object({ bot: { anyOf: [typedRef('bot'), text] }, subscription: wakeupSelection, event_or_time: wakeupRule, enabled: flag },
      ['bot', 'subscription']), wakeupPlatformArgs],
];

export const tools = Object.freeze(definitions.map(([name, description, inputSchema, toPlatformArgs]) =>
  Object.freeze({ name, description, inputSchema, toPlatformArgs })));
export const toolNames = Object.freeze(tools.map(tool => tool.name));
const eventMatch = object({ path: text, equals: { anyOf: [text, flag, integer] } }, ['path', 'equals']);
const adapterRecipe = object({ args: array(text), resume_args: array(text), stdin: flag, output: oneOf('plain', 'json', 'jsonl'),
  session_id: text, progress: text, result: text, error: text, complete_when: eventMatch, success_when: eventMatch }, ['args', 'output']);
const launchArguments = object({ common: array(text), start: array(text), resume: array(text) });
export const connectionSetupTool = Object.freeze({ name: 'initialize_execution',
  executionTools: Object.freeze(['find', 'read', 'open_session', 'send_input', 'stop_session', 'save_file', 'create_bot', 'configure_bot', 'set_wakeup']),
  description: 'Read the installed Summon guide, discover or inspect tools in the local execution environment, and register or update execution connections. ' +
    'Use target to ground discovery in a readable Session, connection or work event. Set query for name or capability, command for an executable name, or executable for a known absolute path. ' +
    'Use inspect to run read-only probe arguments (defaults to --version and --help; pass args or diagnostic_args for custom read-only checks) and read the raw exitCode, stdout and stderr directly. ' +
    'Use register with protocol and config for a CLI, Codex, SSH, HTTP or MCP binding. For updates, pass the original connection ID and current revision. ' +
    'Use upsert_method with connection, revision and method to update one method. Use assign_maintainer to bind a dedicated catalog-maintainer Bot with automatic repair and workspace authority.',
  inputSchema: object({ action: oneOf('guide', 'discover', 'inspect', 'source', 'documentation', 'register', 'upsert_method', 'assign_maintainer'),
    connector: text, target: { ...ref, description: 'Optional connection, session, or work event reference to select the binding or environment.' },
    workspace: refOrId, query: text, required_version: text,
    command: text, executable: text, help_topic: text, offset: integer, protocol: oneOf('cli', 'codex', 'ssh', 'http', 'mcp'),
    args: { ...array(text), description: 'Optional custom read-only probe arguments for inspect.' },
    diagnostic_args: { ...array(text), description: 'Optional additional one-off read-only probe arguments for inspect.' },
    example: oneOf('probe', 'session'),
    config: { type: 'object', additionalProperties: true,
      description: 'Settings for the specified protocol, including optional detected_version, methods, launch_arguments or adapter.' },
    method: { type: 'object', additionalProperties: true },
    connection: { ...text, description: 'The id string of the existing connection from discover or find.' }, revision: integer,
    bot: { ...text, description: 'The Bot id string to assign as maintainer.' },
    name: text, adapter: { anyOf: [object({ arguments: launchArguments }, ['arguments']), object({ recipe: adapterRecipe }, ['recipe']),
      object({ source: text, runner: refOrId, resume: flag }, ['source', 'runner'])] } }, ['action']) });
const byName = new Map([...tools, connectionSetupTool].map(tool => [tool.name, tool]));
const runtimeInputs = new Map([
  ['send', object({ to: refOrId, ...roomMessageFields, repair_key: text, repair_outcome: repairOutcome }, ['to'])],
  ['set_wakeup', object({ bot: refOrId, event_or_time: { anyOf: [...subscriptionRules,
    object({ kind: oneOf('time'), ...timeFields, interval_ms: interval }, ['kind', 'at'])] },
    id: text, revision: integer, enabled: flag }, ['bot'])],
  ['open_session', publicOpenSessionInput], [connectionSetupTool.name, {
  ...connectionSetupTool.inputSchema, properties: { ...connectionSetupTool.inputSchema.properties, connection: refOrId },
}]]);
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

export function nativeProbeArgs(args) {
  return Array.isArray(args) && args.length <= 128 && args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'));
}

export function validateAdapterRecipe(recipe) {
  const paths = ['session_id', 'progress', 'result', 'error'].map(key => recipe?.[key]).filter(path => path !== undefined);
  for (const rule of [recipe?.complete_when, recipe?.success_when]) if (rule) paths.push(rule.path);
  const hasPrompt = args => recipe.stdin === true || args.some(arg => /\{\{(?:text|prompt_file)\}\}/.test(arg));
  const validArgs = args => args.length <= 128 && args.every(arg => arg.length <= 32768 && !arg.includes('\0'));
  if (!matches(adapterRecipe, recipe) || paths.some(path => !/^[\w-]+(?:\.[\w-]+){0,9}$/.test(path)) ||
      !validArgs(recipe.args) || !hasPrompt(recipe.args) || recipe.output === 'jsonl' && !recipe.complete_when ||
      recipe.resume_args && (!validArgs(recipe.resume_args) || !recipe.session_id || recipe.output === 'plain' ||
        !hasPrompt(recipe.resume_args) || !recipe.resume_args.some(arg => arg.includes('{{session_id}}'))))
    reject('invalid_adapter', 'Use a text input, bounded argument templates and an observable output mapping');
}

export function validateLaunchArguments(options, connector) {
  if (!matches(launchArguments, options))
    reject('invalid_adapter', 'Launch arguments must use common, start, or resume string arrays');
  const args = Object.values(options).flat();
  if (args.length > 64) reject('invalid_adapter', 'Supply up to 64 native option arguments');
  const reserved = connector ? ['--help', '--version', ...(connector.protocolOptions || [])] : [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.length || arg.length > 32768 || arg.includes('\0'))
      reject('invalid_adapter', 'Use bounded non-empty argument strings');
    const option = /^--[a-z][a-z0-9-]*/i.exec(arg)?.[0];
    if (option && reserved.includes(option))
      reject('connector_argument_reserved', `The built-in connector manages ${option}`, 409);
  }
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
