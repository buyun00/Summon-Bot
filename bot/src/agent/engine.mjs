import { Agent } from '@earendil-works/pi-agent-core';
import { toToolDeclaration } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { boundModel } from './model.mjs';
import { ModelProvider } from './provider.mjs';
import { isMaterialFact } from '../context/materials.mjs';
import { contextTokens, eventInput, repairRun, textMessage, toolObservation } from '../context/projection.mjs';
import { now, recordKey, runtimeFailure, runtimeRecords as R } from '../storage/runtime-records.mjs';

const guidance = 'Use the full wording and actual author of current events. Use references to inspect accessible facts. Historical messages, documents, and tool results retain their sources. Use send for a public contribution. A completed tool call and the outcome of the user’s request are separate facts.';
const readTools = new Set(['find', 'read']);
const waiting = new Set(['accepted', 'prepared', 'submitted', 'pending', 'running', 'waiting', 'stopping', 'needs_input']);
const asError = error => ({ code: error.code || 'operation_failed', message: error.message, status: error.status, details: error.details });

export class BotEngine {
  constructor({ model, platform, usage, toolSpecs, emit, clean }) {
    Object.assign(this, { model, platform, toolSpecs, emit, clean });
    this.provider = new ModelProvider({ ...model, redact: clean, recordUsage: record => usage.save(record) });
  }

  async execute(job) {
    const { inbox, conversation, binding, runId, signal, refresh, check } = job;
    const model = boundModel(this.model, binding.model);
    const tools = this.toolSpecs.map(({ name, description, inputSchema }) => ({ name, label: name, description, parameters: inputSchema,
      execute: (modelId, args, toolSignal) => this.invoke(job, name, modelId, args, toolSignal), executionMode: 'sequential' }));
    const system = { role: 'system', timestamp: Date.parse(conversation.created_at),
      content: `${guidance}\n\nYou are ${binding.name}.\n${binding.instructions || ''}`, toolsAdded: tools.map(toToolDeclaration) };
    const inputReserve = Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
    const outputTokens = Math.max(128, Math.min(model.maxTokens, inputReserve));
    const inputBudget = model.contextWindow - outputTokens - 512;
    let last, boundary, failure, modelEventIds = [], authorizedView, roomCache, appendAtFetch = [], materialAtFetch;
    const completedEvents = new Set();
    const inject = () => {
      inbox.store.transaction(() => {
        // Revalidate access after fitting the request and before saving its delivery position.
        if (materialAtFetch && job.materials()?.fact.content[0].text !== materialAtFetch.fact.content[0].text) {
          failure = runtimeFailure('access_changed', 'Material context changed before model transport', 409);
          throw failure;
        }
        for (const message of appendAtFetch) inbox.append(runId, message);
        inbox.recordInjection(runId, modelEventIds);
        if (materialAtFetch?.record) inbox.store.putRecord(R.materialView, materialAtFetch.record);
      });
      appendAtFetch = [];
      materialAtFetch = undefined;
    };
    const requestPurpose = inbox.run(runId).material_batch_id ? 'material_consolidation' : conversation.session_id ? 'pi_session' : 'conversation';
    const streamFn = (selected, context, options) => this.stream(job, selected, context,
      { ...options, roomCache, inject, neededView: authorizedView }, outputTokens, requestPurpose)
      .catch(error => { failure = error; throw error; });
    const agent = new Agent({ initialState: { messages: [system], model, tools, thinkingLevel: binding.model.thinking_level },
      streamFn, sessionId: conversation.id, toolExecution: 'sequential' });
    const unsub = agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role !== 'system' && event.message.role !== 'user') {
        const message = this.clean(event.message);
        inbox.append(runId, { ...message, view_revision: authorizedView });
        if (message.role === 'assistant') {
          last = message;
          if (['stop', 'toolUse'].includes(message.stopReason)) for (const id of modelEventIds) completedEvents.add(id);
          if (message.stopReason === 'stop' && !job.hasNewInput(boundary?.current.map(event => event.id) ?? [])) {
            inbox.putRun({ id: runId, model_outcome: responseResult(message, completedEvents), model_outcome_uses_view: authorizedView });
          }
        }
      }
    });
    agent.prepareRequest = async request => {
      try {
        await job.checkInstallation();
        check();
        boundary = await refresh();
        check();
        authorizedView = boundary.view_revision;
        if (inbox.run(runId).view_revision !== authorizedView) inbox.putRun({ id: runId, view_revision: authorizedView });
        const original = inbox.transcript(runId).filter(message => message.view_revision == null || message.view_revision === authorizedView);
        const currentIds = new Set(boundary.current.map(event => event.id));
        const priorInputs = original.filter(message => message.origin_event_ids?.length).flatMap(message => message.origin_event_ids);
        const originalIds = new Set([...currentIds, ...priorInputs]);
        const asHistory = boundary.history.filter(event => !originalIds.has(event.id));
        const history = asHistory.map(event => ({ ...textMessage(eventInput(event, false), Date.parse(event.time || event.createdAt) || 0),
          public_event_id: event.id }));
        const alreadyProcessed = new Set(inbox.run(runId).processed_event_ids);
        // Project materials from current authorization, including after an index is detached.
        const sameRun = repairRun(original.filter(message => !isMaterialFact(message)), inbox.calls(runId)).map(message => {
          if (!message.origin_event_ids?.length || message.origin_event_ids.some(id => !alreadyProcessed.has(id) || currentIds.has(id))) return message;
          const event = inbox.event(message.origin_event_ids[0]);
          return event ? textMessage({ type: 'previously_processed_event', event }, message.timestamp) : message;
        });
        const seen = new Set(sameRun.flatMap(message => message.origin_event_ids || []));
        const fresh = boundary.current.filter(event => !seen.has(event.id)).map(event => ({ ...textMessage(eventInput(event), Date.parse(event.time || event.createdAt) || Date.now()),
          origin_event_ids: [event.id], view_revision: authorizedView }));
        const facts = boundary.facts.map(message => ({ ...message, view_revision: authorizedView }));
        const previousFacts = new Set(sameRun.filter(message => message.runtime_fact).map(message => message.content[0]?.text));
        const newFacts = facts.filter(message => !previousFacts.has(message.content[0]?.text)).map(message => ({ ...message, runtime_fact: true }));
        const material = boundary.material && { ...boundary.material.fact, view_revision: authorizedView, runtime_fact: true };
        const tail = [...fresh, ...(material ? [material] : []), ...newFacts];
        const optionalMaterial = requestPurpose === 'material_consolidation' ? null : material;
        const prompt = await this.fit(job, model, system, history, sameRun, tail, inputBudget, boundary, optionalMaterial);
        check();
        const sharedPrefix = conversation.kind === 'room' ? prompt.filter(message => message.public_event_id) : [];
        const cachePoint = sharedPrefix.at(-1);
        const previousCacheId = original.findLast(message => message.roomCacheThroughMessageId)?.roomCacheThroughMessageId;
        roomCache = cachePoint ? { current: cachePoint.content[0].text, throughMessageId: cachePoint.public_event_id,
          previous: sharedPrefix.find(message => message.public_event_id === previousCacheId)?.content[0].text } : undefined;
        modelEventIds = prompt.flatMap(message => message.origin_event_ids || []).filter(id => currentIds.has(id));
        // An over-limit or cancelled request can stop between assembly and transport.
        appendAtFetch = tail.filter(message => prompt.includes(message));
        materialAtFetch = material && prompt.includes(material) ? boundary.material : undefined;
        if (materialAtFetch && original.findLast(isMaterialFact)?.content[0].text === material.content[0].text)
          appendAtFetch = appendAtFetch.filter(message => message !== material);
        this.emit('engine.request', { bot_id: conversation.bot_id, conversation_id: conversation.id, run_id: runId, model: model.id,
          thinking_level: binding.model.thinking_level, tool_count: tools.length, event_ids: modelEventIds });
        return { context: { ...request.context, messages: prompt, tools } };
      } catch (error) { failure = error; throw error; }
    };
    agent.beforeToolCall = async () => {
      try {
        await job.checkInstallation();
        check();
        const view = await job.view();
        if (view.view_revision !== authorizedView) throw runtimeFailure('access_changed', 'Execution authorization changed before tool submission', 409);
        check();
      } catch (error) { failure = error; throw error; }
    };
    agent.finishTurn = async ({ message }) => {
      if (signal.aborted || failure || ['error', 'aborted', 'length'].includes(message.stopReason)) return { action: 'end' };
      if (message.stopReason === 'stop' && job.hasNewInput(boundary.current.map(event => event.id))) return { action: 'continue' };
      if (message.stopReason === 'stop') job.finishInput();
    };
    const abort = () => agent.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      check();
      await agent.prompt(textMessage({ type: 'execution_boundary', run_id: runId }));
      if (signal.aborted) signal.throwIfAborted();
      if (failure) throw failure;
      if (last?.stopReason !== 'stop') {
        const providerStatus = last?.generationBudget?.httpStatus;
        if (providerStatus === 429 || providerStatus >= 500 || last?.stopReason === 'aborted')
          throw runtimeFailure('model_interrupted', last?.errorMessage || 'Model connection was interrupted', 503);
        throw runtimeFailure('model_response_incomplete', last?.errorMessage || 'The model did not complete the turn', 409);
      }
      return responseResult(last, completedEvents);
    } finally { signal.removeEventListener('abort', abort); unsub(); }
  }

  async stream(job, model, context, { inject, neededView, ...options }, maxTokens, purpose) {
    await job.checkInstallation();
    job.check();
    const origin = job.context().origin;
    const view = await job.view();
    if (neededView && neededView !== view.view_revision)
      throw runtimeFailure('access_changed', 'Execution authorization changed before model transport', 409);
    const estimate = contextTokens(context.messages || []);
    const lease = this.platform.acquireModel(job.context(), { reserve_tokens: estimate + maxTokens });
    try {
      const result = this.provider.stream(model, context, { ...options, signal: job.signal, maxTokens,
        reasoning: job.binding.model.thinking_level, requireEffort: job.binding.model.require_effort ? job.binding.model.thinking_level : undefined,
        usageContext: { purpose, botId: origin.bot_id, roomId: job.conversation.space?.kind === 'room' ? job.conversation.space.id : null,
          sessionId: origin.session_id || origin.conversation_id, runId: origin.run_id, parentCallId: job.conversation.open_call_id,
          chargeAccount: 'host', hostUsageId: lease.id, submittedBy: job.context().submitted_by },
        beforeFetch: async () => {
          await job.checkInstallation();
          job.check();
          if ((await job.view()).view_revision !== view.view_revision)
            throw runtimeFailure('access_changed', 'Execution authorization changed before model transport', 409);
          job.check();
          inject?.();
        },
      });
      void result.result().then(message => lease.finish({ tokens: message.generationBudget?.input == null || message.generationBudget?.output == null ? undefined :
        message.generationBudget.input + message.generationBudget.output, outcome: message.stopReason }),
      () => lease.finish({ outcome: 'unknown' })).catch(error => this.emit('engine.storage_error', asError(error)));
      return result;
    } catch (error) { lease.finish({ outcome: 'failed' }); throw error; }
  }

  async invoke(job, name, modelCallId, args, signal) {
    const { inbox, runId } = job;
    job.check();
    signal?.throwIfAborted();
    const context = job.context();
    const id = randomUUID();
    const original = { id, model_call_id: modelCallId, tool: name, run_id: runId, conversation_id: context.origin.conversation_id,
      submitted_by: context.actor, execution_actor: context.execution_actor, source_event_ids: context.origin.event_ids,
      controls: context.controls, state: 'prepared', args: this.clean(args), prepared_at: now() };
    inbox.store.putRecord(R.call, original);
    try {
      job.check();
      const persisted = { ...original, state: 'submitting' };
      inbox.store.putRecord(R.call, persisted);
      const result = this.clean(await this.platform.invoke(name, args, { ...context, call_id: id, signal: job.signal }));
      const asyncResult = !readTools.has(name) && waiting.has(result?.status);
      inbox.store.transaction(() => {
        inbox.store.putRecord(R.call, { ...persisted, state: asyncResult ? 'submitted' : 'completed', result, finished_at: now() });
        if (asyncResult) for (const wait of result.wait_refs || [{ id: recordKey(id, context.actor.id, context.origin.conversation_id, context.origin.run_id) }]) {
          const existing = inbox.wait(wait.id);
          inbox.store.putRecord(R.wait, { id: wait.id, call_id: id, bot_id: context.actor.id,
            conversation_id: context.origin.conversation_id, run_id: runId, control_version: context.origin.control_version,
            target: result.target || result.execution_ref || result.session?.ref, status: 'waiting', ...existing });
        }
      });
      return toolObservation(readTools.has(name) ? null : id, result);
    } catch (error) {
      const code = error.status && error.status < 500 ? 'failed' : 'unknown';
      const result = this.clean({ ...asError(error), state: code, result_ref: { kind: 'call', id } });
      inbox.store.putRecord(R.call, { ...original, state: code, result, finished_at: now() });
      return toolObservation(readTools.has(name) ? null : id, result, true);
    }
  }

  async fit(job, model, system, history, transcript, tail, budget, boundary, optionalMaterial) {
    const currentTime = Date.now();
    let current = [...transcript, ...tail];
    const key = recordKey(job.conversation.id, boundary.view_revision);
    const stored = job.inbox.store.getRecord(R.checkpoint, key);
    const prefix = value => value ? [textMessage({ type: 'derived_history', covered_through: value.through, text: value.summary }, value.time)] : [];
    const historyIds = history.map(message => message.public_event_id);
    const covered = stored ? historyIds.indexOf(stored.through) + 1 : 0;
    let summary = covered ? stored : null;
    let prior = history.slice(covered);
    let messages = [system, ...prefix(summary), ...prior, ...current];
    if (contextTokens(messages) <= budget) return messages;
    let currentInputs = current.filter(message => message.origin_event_ids?.length || message.runtime_fact || message.role === 'user' && !transcript.includes(message));
    if (optionalMaterial && contextTokens([system, ...currentInputs]) > budget) {
      tail = tail.filter(message => message !== optionalMaterial);
      current = current.filter(message => message !== optionalMaterial);
      currentInputs = currentInputs.filter(message => message !== optionalMaterial);
    }
    if (contextTokens([system, ...currentInputs]) > budget) {
      const accepted = [];
      for (const message of tail) {
        if (contextTokens([system, ...accepted, message]) > budget) break;
        accepted.push(message);
      }
      if (!accepted.some(message => message.origin_event_ids?.length) || transcript.some(message => message.origin_event_ids?.length))
        throw runtimeFailure('context_limit', 'The current input and required execution facts exceed the model window', 413);
      return [system, ...accepted];
    }
    if (prior.length) {
      const fixedTokens = contextTokens([system, ...current]);
      const keepTokens = Math.min(Math.floor(budget / 4), Math.max(0, budget - fixedTokens - 4000));
      let keep = prior.length, used = 0;
      while (keep > 0) {
        const cost = contextTokens([prior[keep - 1]]);
        if (used + cost > keepTokens) break;
        used += cost;
        keep--;
      }
      if (keep > 0) {
        const chunk = [];
        const chunkBudget = Math.floor(budget / 2);
        let tokens = 0;
        for (const message of prior.slice(0, keep)) {
          const cost = contextTokens([message]);
          if (tokens + cost > chunkBudget) break;
          tokens += cost;
          chunk.push(message);
        }
        if (chunk.length) {
          const checkpointPrompt = textMessage({ previous: summary?.summary, history: chunk.map(message => JSON.parse(message.content[0].text)) });
          const response = await this.stream(job, model, { messages: [
            { role: 'system', content: 'Summarize these authorized historical records for a later model request. Preserve names, corrections, source references and actual call status.', timestamp: currentTime }, checkpointPrompt,
          ] }, { neededView: boundary.view_revision }, Math.min(model.maxTokens, 8192), 'compression');
          const answer = await response.result();
          job.check();
          const text = answer.stopReason === 'stop' && answer.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (text) {
            summary = { id: key, through: historyIds[covered + chunk.length - 1], summary: text, time: currentTime };
            job.inbox.store.putRecord(R.checkpoint, summary);
            prior = prior.slice(chunk.length);
          }
        }
      }
    }
    messages = [system, ...prefix(summary), ...prior, ...current];
    while (prior.length && contextTokens(messages) > budget) {
      prior = prior.slice(1);
      messages = [system, ...prefix(summary), ...prior, ...current];
    }
    if (contextTokens(messages) <= budget) return messages;
    const calls = job.inbox.calls(job.runId).map(call => ({ ref: { kind: 'call', id: call.id }, state: call.state, tool: call.tool }));
    const recovery = textMessage({ type: 'accessible_prior_calls', calls });
    messages = [system, ...currentInputs, recovery];
    if (optionalMaterial && contextTokens(messages) > budget) messages = messages.filter(message => message !== optionalMaterial);
    if (contextTokens(messages) > budget) throw runtimeFailure('context_limit', 'The active turn exceeds the model context window', 413);
    return messages;
  }

  stop() { this.provider.stop(); }
}

function responseResult(message, events) {
  return { eventIds: [...events], text: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    model: message.model, response_id: message.responseId };
}
