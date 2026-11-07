import { randomUUID } from 'node:crypto';
import { validateToolArguments } from '@earendil-works/pi-ai';

const effects = new Set(['read', 'write', 'process', 'external']);
const timestamp = () => new Date().toISOString();
const errorRecord = error => ({ name: error?.name || 'Error', message: error?.message || String(error),
  ...(error?.code === undefined ? {} : { code: error.code }),
  ...(error?.accessDenial ? { accessDenial: error.accessDenial } : {}),
  ...(error?.outcomeUnknown ? { outcomeUnknown: true } : {}) });

/** One registry handles native definitions and unchanged SDK tool projections.
 * An audit write must succeed before a side effect starts. A completed side
 * effect is never retried if recording its receipt fails.
 */
export class ToolRegistry {
  constructor({ record = async () => {}, context = () => ({}), authorize = () => {} } = {}) {
    this.definitions = new Map();
    this.record = record;
    this.context = context;
    this.authorize = authorize;
  }

  register(definition) {
    if (!definition || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(definition.name) ||
        this.definitions.has(definition.name) || typeof definition.description !== 'string' ||
        definition.inputSchema?.type !== 'object' || typeof definition.execute !== 'function' ||
        !effects.has(definition.effect)) throw new Error(`Invalid or duplicate tool definition: ${definition?.name}`);
    this.definitions.set(definition.name, Object.freeze({ implementation: 'native', ...definition }));
    return this;
  }

  list() { return [...this.definitions.values()]; }

  async invoke(name, input, suppliedContext = {}) {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Tool "${name}" not found`);
    const context = { ...this.context(suppliedContext), ...suppliedContext };
    context.toolCallId ||= randomUUID();
    context.emitProgress ||= async () => {};
    const createdArtifacts = [];
    if (context.saveArtifact) {
      const save = context.saveArtifact;
      context.saveArtifact = async input => { const reference = await save(input); createdArtifacts.push(reference); return reference; };
    }
    const id = context.recordId || context.toolCallId;
    const record = { id, toolCallId: context.toolCallId, instanceId: context.instanceId, requestId: context.requestId,
      sessionId: context.sessionId, runId: context.runId, name, toolName: name, implementation: definition.implementation,
      effect: definition.effect, cwd: context.cwd, args: input, status: 'running', startedAt: timestamp() };
    await this.record(record);
    let executing = false, recordingOutcome = false;
    try {
      const args = validateToolArguments({ name, parameters: definition.inputSchema }, { name, id: context.toolCallId, arguments: input });
      await this.authorize(definition, args, context);
      context.signal?.throwIfAborted();
      if (context.allowedEffects !== undefined && (!Array.isArray(context.allowedEffects) || !context.allowedEffects.includes(definition.effect))) {
        throw Object.assign(new Error(`Task tool policy denies ${definition.effect} capability ${name}`), { code: 'TOOL_POLICY_DENIED' });
      }
      executing = true;
      const output = await definition.execute(args, context);
      recordingOutcome = true;
      const artifacts = [...createdArtifacts, ...(Array.isArray(output?.artifacts) ? output.artifacts : [])];
      const status = definition.classify ? definition.classify(output, context) : output?.isError ? 'failed' : 'completed';
      await this.record({ ...record, args, status, output, result: output, artifacts,
        ...(output?.details?.exitCode === undefined ? {} : { exitCode: output.details.exitCode }), finishedAt: timestamp() });
      return output;
    } catch (error) {
      const interrupted = context.signal?.aborted || error?.name === 'AbortError';
      const status = (interrupted || recordingOutcome || error?.outcomeUnknown) && executing && definition.effect !== 'read' ? 'unknown' : interrupted ? 'cancelled' : 'failed';
      try { await this.record({ ...record, status, artifacts: createdArtifacts, error: errorRecord(error), finishedAt: timestamp() }); }
      catch { /* Preserve the original tool failure, including its code and type. */ }
      throw error;
    }
  }

  toSdkTools() {
    return this.list().map(definition => ({
      ...(definition.sdk || {}),
      name: definition.name, description: definition.description, parameters: definition.inputSchema,
      label: definition.sdk?.label || definition.name,
      execute: (toolCallId, input, signal, onUpdate) => this.invoke(definition.name, input, {
        toolCallId, signal, emitProgress: value => onUpdate?.(value),
      }),
    }));
  }
}

export const jsonToolResult = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
