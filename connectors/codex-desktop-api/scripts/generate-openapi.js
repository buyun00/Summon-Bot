import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const param = (name, location, schema, required = false, description) => ({ name, in: location, required, schema, ...(description ? { description } : {}) });
const thread = param('threadId', 'path', { type: 'string' }, true);
const host = param('hostId', 'query', { type: 'string', default: 'local' });
const idem = param('Idempotency-Key', 'header', { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }, true, 'Unique per logical mutation. Persist and reuse the exact key and body after a timeout.');
const response = description => ({ description, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } });
const operation = (summary, { parameters = [], body, success = '200', description } = {}) => ({ summary, ...(description ? { description } : {}), parameters: body ? [...parameters, idem] : parameters, ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}), responses: { [success]: response('Success. Upstream payloads may contain their own status or queued result; HTTP acceptance is not task completion.'), default: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } } } });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1 };
const common = { hostId: { type: 'string', default: 'local' } };
const options = { model: text, thinking: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } };
const paths = {
  '/healthz': { get: { ...operation('Process liveness; does not imply desktop connectivity'), security: [] } },
  '/v1/capabilities': { get: operation('Inspect adapter connectivity, advertised tools and limits', { parameters: [param('connect', 'query', { type: 'boolean', default: false })], description: 'Before explicit executor consent, the default request reports local detection without contacting the desktop. connect=true is reserved for an explicit manual connection handshake and reads the advertised tool catalog only, never account usage. Successful handshake alone does not persist consent.' }) },
  '/v1/openapi.json': { get: operation('Read this OpenAPI document') },
  '/v1/account/usage': { get: operation('Read weekly account usage from the local desktop', { description: 'Read-only, existing Bearer policy. No query parameters. Uses configured local caller context; identifies weekly primary/secondary windows by 10080 minutes. Prefers nonempty rateLimitsByLimitId over legacy rateLimits. Missing data is null with notes. Unsupported tool: 501; missing context/disconnected desktop: 503; upstream failure: 502. No reset or credit redemption.' }) },
  '/v1/projects': { get: operation('List saved projects') },
  '/v1/threads': {
    get: operation('List recent and pinned desktop chats', { parameters: [param('limit', 'query', { type: 'integer', default: 50, minimum: 1, maximum: 50 }), param('status', 'query', { type: 'string' })], description: 'limit applies to recent unpinned chats. All pinned chats are included. status is filtered after that window; this is not a globally paginated query.' }),
    post: operation('Create a desktop chat and submit its initial prompt', { success: '201', body: ref('CreateThread'), description: 'Reads the saved local desktop permission selection and verifies a loaded local calling context with matching built-in profile, sandbox, approval policy and reviewer before submitting the original prompt once. No bootstrap turn or post-start permission repair. Returns permissionInheritance evidence. Missing defaults/context or unsupported custom/profile/server-default selection fails before creation. Creation accepted but subsequent verification unavailable/mismatched reports an unknown outcome with threadId; never retry with a new idempotency key. Tested permission inheritance: Windows desktop 26.1027.3384.0, agent modes full-access/read-only/auto/granular; real write verification covers full-access + never only.' }),
  },
  '/v1/threads/archived': { get: operation('List archived Codex chats', { parameters: [host, param('limit', 'query', { type: 'integer', minimum: 1, maximum: 50, default: 20 }), param('cursor', 'query', text)] }) },
  '/v1/threads/{threadId}': {
    get: operation('Read chat metadata and recent turn summaries', { parameters: [thread, host] }),
    patch: operation('Rename a local chat', { parameters: [thread], body: object({ title: { ...text, maxLength: 200 } }, ['title']) }),
  },
  '/v1/threads/{threadId}/messages': {
    get: operation('Page turn and output summaries', { parameters: [thread, host, param('cursor', 'query', text), param('limit', 'query', { type: 'integer', minimum: 1, maximum: 10, default: 3 }), param('includeOutputs', 'query', { type: 'boolean', default: true }), param('maxOutputCharsPerItem', 'query', { type: 'integer', minimum: 0, maximum: 20000, default: 4000 })], description: 'Returns desktop read_thread summaries. Output can be truncated. Follow page.nextCursor; private reasoning items are excluded.' }),
    post: operation('Send a message through the desktop', { parameters: [thread], success: '202', body: object({ message: { ...text, maxLength: 100000 }, ...common, ...options }, ['message']), description: 'Desktop decides active-turn delivery or starting a new turn. The body reports the actual result. No independent executor or queue fallback is started by this service.' }),
  },
  '/v1/threads/{threadId}/state': { get: operation('Get a live IPC snapshot without resuming the task', { parameters: [thread, host], description: 'Returns 503/502 if no live owner or current snapshot is available. Never treats saved lifecycle records as current state.' }) },
  '/v1/threads/{threadId}/interrupt': { post: operation('Interrupt exactly the expected active turn', { parameters: [thread], body: object({ expectedTurnId: text, ...common }, ['expectedTurnId']) }) },
  '/v1/events': { get: { ...operation('Subscribe to SSE and replay retained events', { parameters: [param('threadId', 'query', text), host, param('after', 'query', { type: 'integer', minimum: 0 }), param('Last-Event-ID', 'header', { type: 'integer', minimum: 0 })], description: 'Events: stream.ready, threads.changed, thread.snapshot, thread.status, item.updated, output.delta, thread.gap, desktop.disconnected, desktop.protocol_mismatch. threadId subscribes explicitly; omitted means monitored chats. Initial snapshots have no event ID. Last-Event-ID refers to this service journal; expired cursors return 409. Streams contain visible content, not private reasoning.' }), responses: { '200': { description: 'SSE stream, heartbeat every 15 seconds', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '409': response('Cursor expired'), default: response('Error') } } },
  '/v1/operations/{key}': { get: operation('Inspect mutation outcome after timeout or restart', { parameters: [param('key', 'path', text, true)] }) },
};
for (const action of ['archive', 'unarchive', 'read-state']) paths[`/v1/threads/{threadId}/${action}`] = { post: operation(action === 'read-state' ? 'Set read or unread state' : `${action} a chat`, { parameters: [thread], body: object({ ...common, ...(action === 'read-state' ? { read: { type: 'boolean' } } : {}) }, action === 'read-state' ? ['read'] : []) }) };
const nullableNumber = { type: ['number', 'null'] };
const nullableDate = { type: ['string', 'null'], format: 'date-time' };
const weeklyWindow = object({ limitId: text, window: { enum: ['primary', 'secondary'] }, limit: { const: 100 }, used: nullableNumber, remaining: { ...nullableNumber, minimum: 0, maximum: 100 }, unit: { const: 'percent' }, windowDurationMins: { const: 10080 }, periodStart: nullableDate, periodEnd: nullableDate, periodStartDerived: { type: 'boolean' }, notes: { type: 'array', items: text } }, ['limitId', 'window', 'limit', 'used', 'remaining', 'unit', 'windowDurationMins', 'periodStart', 'periodEnd', 'periodStartDerived', 'notes']);
paths['/v1/account/usage'].get.responses['200'] = { description: 'Fresh desktop read. Percent capacity is normalized to 100, not an absolute allowance. Start is derived from reset minus duration; observedAt is bridge receipt time. Missing fields are null with notes.', content: { 'application/json': { schema: ref('AccountUsage') } } };
const document = {
  openapi: '3.1.0', info: { title: 'Codex Desktop API', version: '0.1.0', description: 'Windows local desktop bridge with an API testing page. Private desktop IPC, tested with 26.1021.3705.0. Bearer authentication is required for remote/forwarded requests or when explicitly enabled. Local loopback bypass is configurable. Existing local caller thread context is configured at installation.' },
  servers: [{ url: 'http://127.0.0.1:47831' }], security: [{ bearerAuth: [] }], paths,
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
    AccountUsage: object({ source: { const: 'desktop_get_usage_limits' }, hostId: { const: 'local' }, observedAt: { type: 'string', format: 'date-time' }, weekly: { type: ['array', 'null'], items: weeklyWindow }, notes: { type: 'array', items: text } }, ['source', 'hostId', 'observedAt', 'weekly', 'notes']),
    Error: object({ error: object({ code: text, message: text, details: {} }, ['code', 'message']), requestId: text }, ['error']),
    CreateThread: object({ prompt: { ...text, maxLength: 100000 }, title: { ...text, maxLength: 200 }, ...options, target: { oneOf: [object({ type: { const: 'projectless' }, directoryName: { ...text, maxLength: 100 } }, ['type']), object({ type: { const: 'project' }, projectId: text, environment: object({ type: { const: 'local' } }, ['type']) }, ['type', 'projectId'])], default: { type: 'projectless' } } }, ['prompt']),
  } },
};
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'openapi.json'), JSON.stringify(document, null, 2) + '\n');
console.log('Generated docs/openapi.json');
