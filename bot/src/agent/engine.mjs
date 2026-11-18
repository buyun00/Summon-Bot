import { Agent } from '@earendil-works/pi-agent-core';
import { toToolDeclaration } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { connectionSetupTool } from '../../../capabilities/platform/contract.mjs';
import { builtInInstructions } from '../../../roles/index.mjs';
import { boundModel } from './model.mjs';
import { ModelProvider } from './provider.mjs';
import { isMaterialFact } from '../context/materials.mjs';
import { contextTokens, eventInput, repairRun, textMessage, toolObservation } from '../context/projection.mjs';
import { fitObservation, observationReadRefs, observedResult, uniqueRefs } from '../context/room-observation.mjs';
import { fitRoomHistory } from '../context/room-history.mjs';
import { now, recordKey, runtimeFailure, runtimeRecords as R } from '../storage/runtime-records.mjs';

const guidance = 'Use the full wording and actual author of current events. Use references to inspect accessible facts. ' +
  'Historical messages, documents, and tool results retain their sources. Use send for a public contribution. ' +
  'When delegating work, include the user’s applicable requirements, completion criteria, and limits on work, verification, or reporting in the executor’s input. ' +
  'Share only what the recipient is authorized to receive. Submit work on behalf of a Room with work_room and use its actual source event when available. ' +
  'Enabled tools and their registered methods are available to every Bot. A group’s project directory follows its current members into Pi and external Sessions. ' +
  'Use find(kind=workspace), read with a workspace ref and relative path, and save_file with the workspace as space to edit project text. ' +
  'Use registered connections directly for the task and handle input errors using their real receipts. If the evidence shows the connection, fixed method or script needs repair, ' +
  'use send to the original connection with shareable references to the failed call or probe. Reuse the request for the same verified fault. ' +
  'Use the repair receipt in the originating task. If the original operation has an unknown outcome, query its actual state before submitting again. ' +
  'When the delegated task is to write a Summon adapter, use include_execution_guide or put the relevant same-release guide text in the input. Pass along user changes that affect the delegated work. ' +
  'Conclude when the existing outputs and receipts satisfy the current request.';
const setupGuidance = 'The host authorized CLI setup for this private conversation. Use the initialize_execution guide, installed CLI observations, and existing grants. ' +
  'For a registered CLI, look up its actual maintainer. Reuse a suitable maintainer, and provision a new Bot only when it has an independent ongoing duty. ' +
  'Use set_wakeup for ongoing connection failure notices when needed and within scope. Report the actual maintainer reference when assigned. ' +
  'Continue the authorized CLI work when the connection is usable. Use regular Session tools for the user’s requested work.';
const readTools = new Set(['find', 'read']);
const waiting = new Set(['accepted', 'prepared', 'submitted', 'pending', 'running', 'waiting', 'stopping', 'needs_input']);
const asError = error => ({ code: error.code || 'operation_failed', message: error.message, status: error.status, details: error.details });

export class BotEngine {
  constructor({ model, platform, usage, toolSpecs, emit, clean, reportUsageError }) {
    Object.assign(this, { model, platform, toolSpecs, emit, clean });
    this.provider = new ModelProvider({ ...model, redact: clean, recordUsage: record => usage?.save(record),
      reportUsageError });
  }

  async execute(job) {
    const { inbox, conversation, binding, runId, signal, refresh, check } = job;
    const model = boundModel(this.model, binding.model);
    const setup = conversation.kind === 'connection_setup';
    const available = conversation.embedded_initializer ? this.toolSpecs.filter(tool => connectionSetupTool.executionTools.includes(tool.name)) : this.toolSpecs;
    const specs = setup || this.platform.canInitializeExecution(job.context()) ? [...available, connectionSetupTool] : available;
    const tools = specs.map(({ name, description, inputSchema, toPlatformArgs }) => ({ name, label: name, description, parameters: inputSchema,
      execute: (modelId, args, toolSignal) => this.invoke(job, name, modelId, toPlatformArgs ? toPlatformArgs(args) : args, toolSignal),
      executionMode: 'sequential' }));
    const systemBase = { role: 'system', timestamp: Date.parse(conversation.created_at),
      content: `${guidance}${setup ? `\n\n${setupGuidance}` : ''}\n\nYou are ${binding.name}.`, toolsAdded: tools.map(toToolDeclaration) };
    const userInstructions = binding.instructions || '';
    const inputReserve = Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
    const outputTokens = Math.max(128, Math.min(model.maxTokens, inputReserve));
    const inputBudget = model.contextWindow - outputTokens - 512;
    let last, boundary, failure, modelEventIds = [], authorizedView, roomCache, appendAtFetch = [], materialAtFetch;
    let observationWindow, fittedObservation, transportedObservation, outcome;
    const completedEvents = new Set();
    const inject = () => {
      inbox.store.transaction(() => {
        // Revalidate access after fitting the request and before saving its delivery position.
        if (materialAtFetch && job.materials()?.fact.content[0].text !== materialAtFetch.fact.content[0].text)
          throw runtimeFailure('access_changed', 'Material context changed before model transport', 409);
        if (fittedObservation) {
          if (!fittedObservation.access_refs.every(job.canReadReference))
            throw runtimeFailure('access_changed', 'Room observation access changed before model transport', 409);
          transportedObservation = fittedObservation;
          inbox.putRun({ id: runId, room_observation_input: { generation: boundary.observation.generation,
            from: boundary.observation.start, through: fittedObservation.through, event_ids: [...new Set(fittedObservation.event_ids)],
            previous_run_id: boundary.observation.previous?.run_id ?? null } });
        }
        for (const message of appendAtFetch) inbox.append(runId, message);
        inbox.recordInjection(runId, modelEventIds);
        if (materialAtFetch?.record) inbox.store.putRecord(R.materialView, materialAtFetch.record);
      });
      appendAtFetch = [];
      materialAtFetch = undefined;
    };
    const requestPurpose = inbox.run(runId).material_batch_id ? 'material_consolidation' : conversation.session_id ? 'pi_session' : 'conversation';
    const onBeforeFetchError = error => { failure = error; };
    const streamFn = (selected, context, options) => this.stream(job, selected, context,
      { ...options, roomCache, inject, neededView: authorizedView, onBeforeFetchError }, outputTokens, requestPurpose)
      .catch(error => { failure = error; throw error; });
    const compress = async messages => {
      const response = await this.stream(job, model, { messages }, { neededView: authorizedView, onBeforeFetchError },
        Math.min(model.maxTokens, 8192), 'compression');
      const answer = await response.result();
      if (failure) throw failure;
      return answer;
    };
    const agent = new Agent({ initialState: { messages: [systemBase], model, tools, thinkingLevel: binding.model.thinking_level ?? 'off' },
      streamFn, sessionId: conversation.id, toolExecution: 'sequential' });
    const unsub = agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role !== 'system' && event.message.role !== 'user') {
        const message = this.clean(event.message);
        const tool = transportedObservation && message.role === 'toolResult' &&
          inbox.calls(runId).find(call => call.model_call_id === message.toolCallId);
        const access = transportedObservation && uniqueRefs([...transportedObservation.access_refs, ...(tool?.observation_access ?? [])]);
        inbox.append(runId, { ...message, view_revision: authorizedView,
          ...(access?.length && { observation_access: access }) });
        if (message.role === 'assistant') {
          last = message;
          if (['stop', 'toolUse'].includes(message.stopReason)) for (const id of modelEventIds) completedEvents.add(id);
          if (message.stopReason === 'stop') {
            outcome = responseResult(message, completedEvents);
            if (transportedObservation) outcome.observation = observedResult(job, boundary.observation, transportedObservation, outcome, authorizedView);
            if (!transportedObservation?.more && !job.hasNewInput(boundary.current.map(event => event.id)))
              inbox.putRun({ id: runId, model_outcome: outcome, model_outcome_uses_view: authorizedView });
          }
        }
      }
    });
    agent.prepareRequest = async request => {
      try {
        await job.checkInstallation();
        check();
        boundary = await refresh(observationWindow);
        fittedObservation = transportedObservation = undefined;
        check();
        authorizedView = boundary.view_revision;
        if (inbox.run(runId).view_revision !== authorizedView) inbox.putRun({ id: runId, view_revision: authorizedView });
        const observation = boundary.observation;
        job.observing = Boolean(observation);
        const retained = inbox.transcript(runId).slice(observation?.transcript_start ?? 0).filter(message =>
          message.view_revision == null || job.canRetainAuthorizationView(message.view_revision, authorizedView));
        const transcriptAccess = uniqueRefs(retained.flatMap(message => message.observation_access ?? []));
        const original = transcriptAccess.every(job.canReadReference) ? retained : [];
        const currentIds = new Set(boundary.current.map(event => event.id));
        const priorInputs = original.filter(message => message.origin_event_ids?.length).flatMap(message => message.origin_event_ids);
        const originalIds = new Set([...currentIds, ...priorInputs]);
        const asHistory = boundary.publicRoom ? [] : boundary.history.filter(event => !originalIds.has(event.id));
        const history = asHistory.map(event => ({ ...textMessage(eventInput(event, false), Date.parse(event.time || event.createdAt) || 0),
          public_event_id: event.id }));
        const alreadyProcessed = new Set(inbox.run(runId).processed_event_ids);
        // Project materials from current authorization, including after an index is detached.
        const isPublicEvent = event => boundary.publicRoom && event?.type === 'message' && event.space?.id === conversation.space.id;
        const localMessages = original.filter(message => !isMaterialFact(message) &&
          !message.origin_event_ids?.every(id => isPublicEvent(inbox.event(id))));
        const sameRun = repairRun(localMessages, inbox.calls(runId)).map(message => {
          if (!message.origin_event_ids?.length || message.origin_event_ids.some(id => !alreadyProcessed.has(id) || currentIds.has(id))) return message;
          const event = inbox.event(message.origin_event_ids[0]);
          return event ? textMessage({ type: 'previously_processed_event', event }, message.timestamp) : message;
        });
        const seen = new Set(sameRun.flatMap(message => message.origin_event_ids || []));
        const fresh = boundary.current.filter(event => !seen.has(event.id) && !isPublicEvent(event)).map(event => ({ ...textMessage(eventInput(event), Date.parse(event.time || event.createdAt) || Date.now()),
          origin_event_ids: [event.id], view_revision: authorizedView }));
        const facts = boundary.facts.map(message => ({ ...message, view_revision: authorizedView }));
        const previousFacts = new Set(sameRun.filter(message => message.runtime_fact).map(message => message.content[0]?.text));
        const newFacts = facts.filter(message => !previousFacts.has(message.content[0]?.text)).map(message => ({ ...message, runtime_fact: true }));
        const material = boundary.material && { ...boundary.material.fact, view_revision: authorizedView, runtime_fact: true };
        const tail = [...fresh, ...(observation ? [observation.fact] : []), ...(material ? [material] : []), ...newFacts];
        const optionalMaterial = requestPurpose === 'material_consolidation' ? null : material;
        const duty = builtInInstructions(binding.built_in_role, boundary.maintained_connection_ids);
        const system = { ...systemBase, content: duty ?
          `${systemBase.content}\n\nBuilt-in Bot duties:\n${duty}${userInstructions ? `\n\nUser instructions:\n${userInstructions}` : ''}` :
          `${systemBase.content}\n${userInstructions}` };
        const fit = budget => boundary.publicRoom ? fitRoomHistory(job, compress, system, sameRun, tail, budget, boundary, optionalMaterial) :
          this.fit(job, compress, system, history, sameRun, tail, budget, boundary, optionalMaterial);
        let prompt = await fit(inputBudget);
        if (observation) {
          fittedObservation = fitObservation(observation, prompt, inputBudget);
          if (fittedObservation.more && !fittedObservation.advanced) {
            // Leave room for the oldest unseen original when a long tool transcript filled the request.
            const next = textMessage(eventInput(observation.events[0], false));
            prompt = await fit(inputBudget - contextTokens([next]));
            fittedObservation = fitObservation(observation, prompt, inputBudget);
          }
          if (!prompt.includes(observation.fact) || fittedObservation.more && !fittedObservation.advanced)
            throw runtimeFailure('context_limit', 'This room observation cannot fit the next original and its context', 413);
          if (original.length) fittedObservation.access_refs = uniqueRefs([...fittedObservation.access_refs, ...transcriptAccess]);
          prompt = fittedObservation.messages;
          observationWindow = { generation: observation.generation, base_checkpoint: observation.base_checkpoint, end: observation.end, triggers: [...currentIds],
            draft: observationWindow?.draft === observation.previous ? observation.previous : null };
        }
        check();
        const sharedPrefix = conversation.kind === 'room' ? prompt.filter(message => message.public_event_id) : [];
        const cachePoint = sharedPrefix.at(-1);
        const previousCacheId = original.findLast(message => message.roomCacheThroughMessageId)?.roomCacheThroughMessageId;
        roomCache = cachePoint ? { current: cachePoint.content[0].text, throughMessageId: cachePoint.public_event_id,
          previous: sharedPrefix.find(message => message.public_event_id === previousCacheId)?.content[0].text } : undefined;
        modelEventIds = prompt.flatMap(message => message.origin_event_ids || []).filter(id => currentIds.has(id));
        // An over-limit or cancelled request can stop between assembly and transport.
        appendAtFetch = tail.filter(message => message !== observation?.fact && prompt.includes(message));
        if (boundary.publicRoom) {
          const recorded = new Set(priorInputs);
          appendAtFetch.push(...prompt.filter(message => !tail.includes(message) &&
            message.origin_event_ids?.some(id => !recorded.has(id) && isPublicEvent(inbox.event(id))))
            .map(message => ({ ...message, view_revision: authorizedView })));
        }
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
        if (transportedObservation && !transportedObservation.access_refs.every(job.canReadReference))
          throw runtimeFailure('access_changed', 'Room observation access changed before tool submission', 409);
        check();
      } catch (error) { failure = error; throw error; }
    };
    agent.finishTurn = async ({ message }) => {
      if (signal.aborted || failure || ['error', 'aborted', 'length'].includes(message.stopReason)) return { action: 'end' };
      if (message.stopReason === 'stop' && transportedObservation?.more) {
        observationWindow.draft = outcome.observation.checkpoint;
        return { action: 'continue' };
      }
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
      return outcome;
    } finally { signal.removeEventListener('abort', abort); unsub(); }
  }

  async stream(job, model, context, { inject, neededView, onBeforeFetchError, ...options }, maxTokens, purpose) {
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
        reasoning: job.binding.model.thinking_level,
        usageContext: { purpose, botId: origin.bot_id, roomId: job.conversation.space?.kind === 'room' ? job.conversation.space.id : null,
          sessionId: origin.session_id || origin.conversation_id, runId: origin.run_id, parentCallId: job.conversation.open_call_id,
          chargeAccount: 'host', hostUsageId: lease.id, submittedBy: job.context().submitted_by },
        beforeFetch: async () => {
          try {
            await job.checkInstallation();
            job.check();
            if ((await job.view()).view_revision !== view.view_revision)
              throw runtimeFailure('access_changed', 'Execution authorization changed before model transport', 409);
            job.check();
            boundModel(this.model, job.binding.model);
            inject?.();
          } catch (error) {
            // The provider stream can reduce this exception to a formatted error message.
            onBeforeFetchError?.(error);
            throw error;
          }
        },
      });
      void result.result().then(message => lease.finish({ tokens: message.generationBudget?.input == null || message.generationBudget?.output == null ? undefined :
        message.generationBudget.input + message.generationBudget.output, outcome: message.stopReason }),
      () => lease.finish({ outcome: 'unknown' })).catch(error => this.emit('engine.storage_error', this.clean.error(asError(error))));
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
        const access = job.observing && observationReadRefs(name, args, result).filter(job.canReadReference);
        inbox.store.putRecord(R.call, { ...persisted, state: asyncResult ? 'submitted' : 'completed', result, finished_at: now(),
          ...(access?.length && { observation_access: access }) });
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
      const result = { ...this.clean.error(asError(error)), state: code, result_ref: { kind: 'call', id } };
      inbox.store.putRecord(R.call, { ...original, state: code, result, finished_at: now() });
      return toolObservation(readTools.has(name) ? null : id, result, true);
    }
  }

  async fit(job, compress, system, history, transcript, tail, budget, boundary, optionalMaterial) {
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
          let answer;
          try {
            answer = await compress([
              { role: 'system', content: 'Summarize these authorized historical records for a later model request. Preserve names, corrections, source references and actual call status.', timestamp: currentTime }, checkpointPrompt,
            ]);
          } catch (error) {
            if (error.code !== 'resource_limit') throw error;
          }
          job.check();
          const text = answer?.stopReason === 'stop' && answer.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
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
