const string = { type: 'string' };
const strings = { type: 'array', items: string };
const integer = { type: 'integer', minimum: 0 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name, description, effect, inputSchema) => ({ name: 'catalog_native_' + name, description, effect, inputSchema });
const id = { id: string };
const operation = { workId: string, operationId: string };

export const nativeToolDefinitions = [
  definition('discover', 'Find actual CLI entry points in the host PATH, installed package paths and this project. Provide an executable name or an authorized absolute path to look up one entry. Read candidates, then enroll relevant entries so their maintainers learn the real help and methods.', 'read',
    object({ command: string, cwd: string, query: string, offset: integer, limit: integer })),
  definition('enroll', 'Enroll a discovered CLI entry for real learning and reuse. Existing installations retain their owner and methods. Call again to see the existing work. For API and MCP use catalog_register and catalog_probe.', 'write',
    object({ candidateId: string, name: string, description: string }, ['candidateId'])),
  definition('probe', 'Inspect a CLI executable with read-only version/help arguments. Save the actual output as an observation. The dedicated maintainer can select a documented version probe for this installation.', 'external',
    object({ ...id, args: strings, versionProbe: { type: 'boolean' } }, ['id', 'args'])),
  definition('observations', 'Read an immutable observation for a tool, or list its recent observations and source references.', 'read',
    object({ ...id, observationId: string, offset: integer, limit: integer }, ['id'])),
  definition('method_write', 'Maintain one searchable invocation method for this resource and its observed version. Supply real observation IDs and describe applicability and limitations. CLI methods use args with {{parameter}} placeholders, optional stdin and optional Node script using the Summon JSON-lines bridge. API and MCP methods bind a tool name and arguments.', 'write',
    object({ ...id, expectedRevision: integer, methodId: string, name: string, description: string, sourceIds: strings, args: strings,
      input: string, keepInput: { type: 'boolean' }, protocol: { type: 'string', enum: ['stdin', 'summon-jsonl'] }, script: string,
      env: { type: 'object' }, tool: string, arguments: { type: 'object' }, effect: { type: 'string', enum: ['read', 'write', 'update'] } },
    ['id', 'expectedRevision', 'methodId', 'name', 'description', 'sourceIds'])),
  definition('run', 'Run a current method in the original authorized work using a stable operationId. A CLI method stays alive between Pi turns. For an exploratory or update invocation, the tool maintainer can supply explicit args after inspecting the live interface. resumeFromOperationId binds a known native session from this same work.', 'external',
    object({ ...id, ...operation, methodId: string, expectedMethodRevision: integer, parameters: { type: 'object' }, args: strings, cwd: string, input: string,
      keepInput: { type: 'boolean' }, resumeFromOperationId: string, recoveryBindingId: string, effect: { type: 'string', enum: ['read', 'write', 'update'] }, rationale: string },
    ['id', 'operationId', 'rationale'])),
  definition('status', 'Inspect a durable process or original work bindings. Supply the operationId and optionally a stream and byte cursor for real stdout, stderr or JSON-lines events. This never starts a process.', 'read',
    object({ ...operation, stream: { type: 'string', enum: ['stdout', 'stderr', 'events'] }, offset: integer, limit: integer })),
  definition('input', 'Send a message to this work running process. User permission choices and answers tied to an actual native request are entered from the original work. A stable inputId returns the same submission receipt on retry.', 'external',
    object({ ...operation, inputId: string, text: string }, ['operationId', 'inputId', 'text'])),
  definition('stop', 'Request the original native operation to stop. An event-aware bridge receives a stop message before the process tree is interrupted. Query the actual status after the request.', 'external',
    object(operation, ['operationId'])),
  definition('reconcile', 'Resolve an unknown native outcome once actual effects or the native session were checked. The responsible Bot records evidence and the real terminal state. A replay never substitutes for reconciliation.', 'write',
    object({ ...operation, outcome: { type: 'string', enum: ['completed', 'failed', 'stopped'] }, evidence: string }, ['operationId', 'outcome', 'evidence'])),
  definition('recover', 'Read a migrated native binding or settle it using a real observation from this work. A resumable binding needs the original session identity; an unavailable session needs evidence of the earlier effects. Recovery never replays the original request.', 'write',
    object({ ...id, bindingId: string, disposition: { type: 'string', enum: ['resumable', 'unavailable'] }, observationId: string, evidence: string, offset: integer }, ['bindingId'])),
  definition('observe_schedule', 'Schedule a lightweight version or release observation using a saved current read-only method. CLI version checks also run before a new action. A stable reading does not start a model turn.', 'write',
    object({ ...id, methodId: string, intervalMinutes: integer, parameters: { type: 'object' } }, ['id', 'methodId', 'intervalMinutes'])),
  definition('source_register', 'Register a display source on the resource and account scope. Each action points to a current method or a bounded request for the responsible Bot.', 'write',
    object({ ...id, sourceId: string, label: string, accountRef: string, actions: { type: 'array', items: object({ id: string, label: string, methodId: string, parameters: { type: 'object' } }, ['id', 'label']) } },
    ['id', 'sourceId', 'label'])),
  definition('publish', 'Publish a sourced observation for a registered display source. Supply actual timestamps, units and metrics. revision is the resource revision used when observing. Late revisions are saved as history and cannot replace the current display.', 'write',
    object({ ...id, sourceId: string, revision: integer, sourceRevision: integer, status: string, observedAt: string, validUntil: string, observationId: string,
      note: string, error: string, metrics: { type: 'array', items: { type: 'object' } } },
    ['id', 'sourceId', 'revision', 'sourceRevision', 'status', 'observedAt', 'observationId'])),
];
