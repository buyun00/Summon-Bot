import { setTimeout as delay } from 'node:timers/promises';
import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { retryDelayMs } from '@earendil-works/pi-ai';
import { compact, prepareCompaction, shouldCompact, estimateProjectedContextTokens, estimateContextTokens, estimateTokens, calculateContextTokens } from './compaction.mjs';
import { getLatestCompactionEntry } from '../session-manager.mjs';
const sleep = (ms, signal)=>delay(ms, undefined, {
        signal
    });
const estimateMessagesTokens = (messages)=>messages.reduce((sum, message)=>sum + estimateTokens(message), 0);
const formatNoModelSelectedMessage = ()=>'No model selected';
export class PiCompactionLifecycle {
    constructor({ agent, sessionManager, model, settings, retry, summaryStream, signal, emit, instructions }){
        Object.assign(this, {
            agent,
            sessionManager,
            model,
            summaryStream,
            signal,
            instructions
        });
        this.settingsManager = {
            getCompactionSettings: ()=>settings,
            getRetrySettings: ()=>retry
        };
        this._emit = emit;
        this._retryAttempt = 0;
        this._overflowRecoveryAttempted = false;
        this._lastAssistantToolResults = [];
        this._extensionRunner = {
            hasHandlers: ()=>false,
            emit: async (event)=>this._emit(event)
        };
        this._onAbort = ()=>{
            this._agentRunAbortRequested = true;
            this._autoCompactionAbortController?.abort();
            this._compactionAbortController?.abort();
            this._retryAbortController?.abort();
        };
        signal?.addEventListener('abort', this._onAbort, {
            once: true
        });
        this._unsubscribe = agent.subscribe((event)=>{
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                this._lastAssistantMessage = event.message;
                this.lastOutcome = event.message;
                if (this._retryAttempt > 0 && ![
                    'error',
                    'aborted'
                ].includes(event.message.stopReason)) {
                    this._emit({
                        type: 'auto_retry_end',
                        success: true,
                        attempt: this._retryAttempt
                    });
                    this._retryAttempt = 0;
                }
            }
            if (event.type === 'turn_end') this._lastAssistantToolResults = event.toolResults;
        });
    }
    get thinkingLevel() {
        return this.agent.state.thinkingLevel;
    }
    _modelForMessage(message) {
        return message.provider === this.model.provider && message.model === this.model.id ? this.model : undefined;
    }
    _findPersistedMessageEntryId(message) {
        return this.sessionManager.idForMessage(message);
    }
    _refreshFinalizedContext() {
        this.agent.state.messages = this.sessionManager.buildSessionProjection().messages;
    }
    _resolveIdleWaitIfIdle() {}
    async _emitSessionCompactFailed(event) {
        this.lastCompactionError = event.errorMessage;
        this.lastCompactionFailureReason = event.reason;
        this._emit({
            type: 'session_compact_failed',
            ...event
        });
    }
    async _getSummarizationRequestAuth(model) {
        return {
            model,
            thinkingLevel: this.thinkingLevel
        };
    }
    async abort() {
        this.agent.abort();
        await this.agent.waitForIdle();
    }
    async beforePrompt() {
        this.signal?.throwIfAborted();
        const last = this.agent.state.messages.findLast((message)=>message.role === 'assistant');
        if (last) await this._checkCompaction(last, false);
        this.signal?.throwIfAborted();
        this._refreshFinalizedContext();
    }
    async prepareNextTurn(context) {
        this.signal?.throwIfAborted();
        const next = await this._compactBeforeNextAssistantResponse(context);
        this.signal?.throwIfAborted();
        return {
            context: next
        };
    }
    async afterRun() {
        this.signal?.throwIfAborted();
        const retry = await this._handlePostAgentRun();
        this.signal?.throwIfAborted();
        return retry;
    }
    close() {
        this.signal?.removeEventListener('abort', this._onAbort);
        this._unsubscribe();
    }
    _exceedsCompactionThreshold(model, projection) {
        if (model.contextWindow <= 0) return false;
        return shouldCompact(estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens, model.contextWindow, this.settingsManager.getCompactionSettings(this.model));
    }
    async _compactBeforeNextAssistantResponse(context) {
        const projection = this.sessionManager.buildSessionProjection();
        const model = this.model;
        if (!model || !this._exceedsCompactionThreshold(model, projection)) {
            return {
                ...context,
                messages: projection.messages
            };
        }
        await this._runAutoCompaction("threshold", false);
        return {
            ...context,
            messages: this.sessionManager.buildSessionProjection().messages
        };
    }
    async _runDefaultCompaction(preparation, model, customInstructions, signal, reason) {
        const request = await this._getSummarizationRequestAuth(model, signal);
        return compact(preparation, request.model, request.apiKey, request.headers, customInstructions ?? this.instructions, signal, request.thinkingLevel, this.summaryStream, request.env, this.settingsManager.getRetrySettings(), this._summarizationRetryCallbacks({
            source: "compaction",
            reason
        }), undefined);
    }
    _clearManualCompactionState() {
        this._compactionAbortController = undefined;
        this._resolveIdleWaitIfIdle();
    }
    async compact(customInstructions) {
        await this.abort();
        this._compactionAbortController = new AbortController();
        this._emit({
            type: "compaction_start",
            reason: "manual"
        });
        let fromExtension = false;
        let cancelledByExtension = false;
        try {
            const model = this.model;
            if (!model) {
                throw new Error(formatNoModelSelectedMessage());
            }
            const settings = this.settingsManager.getCompactionSettings(model);
            const pathEntries = this.sessionManager.getBranch();
            const preparation = prepareCompaction(pathEntries, settings);
            if (!preparation) {
                const lastEntry = pathEntries[pathEntries.length - 1];
                if (lastEntry?.type === "compaction") {
                    throw new Error("Already compacted");
                }
                throw new Error("Nothing to compact (session too small)");
            }
            let extensionCompaction;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {
                const result = await this._extensionRunner.emit({
                    type: "session_before_compact",
                    preparation,
                    branchEntries: pathEntries,
                    customInstructions,
                    reason: "manual",
                    willRetry: false,
                    signal: this._compactionAbortController.signal
                });
                if (result?.cancel) {
                    cancelledByExtension = true;
                    throw new Error("Compaction cancelled");
                }
                if (result?.compaction) {
                    extensionCompaction = result.compaction;
                    fromExtension = true;
                }
            }
            let summary;
            let firstKeptEntryId;
            let tokensBefore;
            let usage;
            let details;
            if (extensionCompaction) {
                summary = extensionCompaction.summary;
                firstKeptEntryId = extensionCompaction.firstKeptEntryId;
                tokensBefore = extensionCompaction.tokensBefore;
                usage = extensionCompaction.usage;
                details = extensionCompaction.details;
            } else {
                const result = await this._runDefaultCompaction(preparation, model, customInstructions, this._compactionAbortController.signal, "manual");
                summary = result.summary;
                firstKeptEntryId = result.firstKeptEntryId;
                tokensBefore = result.tokensBefore;
                usage = result.usage;
                details = result.details;
            }
            if (this._compactionAbortController.signal.aborted) {
                throw new Error("Compaction cancelled");
            }
            this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
            const newEntries = this.sessionManager.getEntries();
            this._refreshFinalizedContext();
            const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);
            const savedCompactionEntry = newEntries.find((e)=>e.type === "compaction" && e.summary === summary);
            if (this._extensionRunner && savedCompactionEntry) {
                await this._extensionRunner.emit({
                    type: "session_compact",
                    compactionEntry: savedCompactionEntry,
                    fromExtension,
                    reason: "manual",
                    willRetry: false
                });
            }
            const compactionResult = {
                summary,
                firstKeptEntryId,
                tokensBefore,
                estimatedTokensAfter,
                usage,
                details
            };
            this._clearManualCompactionState();
            this._emit({
                type: "compaction_end",
                reason: "manual",
                result: compactionResult,
                aborted: false,
                willRetry: false
            });
            return compactionResult;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
            const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
            this._clearManualCompactionState();
            this._emit({
                type: "compaction_end",
                reason: "manual",
                result: undefined,
                aborted,
                willRetry: false,
                errorMessage
            });
            await this._emitSessionCompactFailed({
                reason: "manual",
                errorMessage,
                aborted,
                willRetry: false,
                fromExtension
            });
            throw error;
        } finally{
            this._clearManualCompactionState();
        }
    }
    async _checkCompaction(assistantMessage, skipAbortedCheck = true, toolResults = []) {
        const settings = this.settingsManager.getCompactionSettings(this.model);
        if (!settings.enabled) return false;
        if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;
        const messageModel = this._modelForMessage(assistantMessage);
        const sameModel = messageModel !== undefined;
        const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;
        const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
        const assistantIsFromBeforeCompaction = compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
        if (assistantIsFromBeforeCompaction) {
            return false;
        }
        const currentProjection = this.sessionManager.buildSessionProjection();
        const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
        const assistantIsProjected = assistantEntryId === undefined || currentProjection.entries.some((entry)=>entry.sourceEntry.id === assistantEntryId && entry.messages.some((message)=>message.role === "assistant"));
        const branch = this.sessionManager.getBranch();
        const assistantIndex = assistantEntryId ? branch.findIndex((entry)=>entry.id === assistantEntryId) : -1;
        const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
        const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry)=>entry.type === "context_edit");
        const latestAssistantEdit = entriesAfterAssistant.filter((entry)=>entry.type === "context_edit" && entry.targetId === assistantEntryId).at(-1);
        const assistantRetainedForExplicitRecovery = assistantEntryId === undefined || !entriesAfterAssistant.some((entry)=>entry.type === "compaction") && latestAssistantEdit?.replacement !== null;
        const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
        const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
        const contextOverflow = sameModel && (explicitOverflow && assistantRetainedForExplicitRecovery || assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow));
        const recoverableLength = sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
        if (contextOverflow || recoverableLength) {
            const willRetry = assistantMessage.stopReason !== "stop";
            if (!willRetry) {
                return await this._runAutoCompaction("overflow", false);
            }
            if (this._overflowRecoveryAttempted) {
                const errorMessage = contextOverflow ? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model." : "Truncated response recovery failed after one compact-and-retry attempt.";
                this._emit({
                    type: "compaction_end",
                    reason: "overflow",
                    result: undefined,
                    aborted: false,
                    willRetry: false,
                    errorMessage
                });
                await this._emitSessionCompactFailed({
                    reason: "overflow",
                    errorMessage,
                    aborted: false,
                    willRetry: false,
                    fromExtension: false
                });
                return false;
            }
            this._overflowRecoveryAttempted = true;
            this._omitRecoveryAttempt(assistantMessage, toolResults);
            const retry = await this._runAutoCompaction("overflow", willRetry);
            if (retry) this._failedResponse = assistantMessage;
            return retry;
        }
        let contextTokens;
        const projection = currentProjection;
        const hasContextEdits = projection.entries.some((entry)=>entry.sourceEntry.type === "context_edit");
        const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
        if (hasContextEdits) {
            contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
        } else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
            const messages = this.agent.state.messages;
            const estimate = estimateContextTokens(messages);
            if (estimate.lastUsageIndex !== null) {
                const usageMsg = messages[estimate.lastUsageIndex];
                if (compactionEntry && usageMsg.role === "assistant" && usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
                    return false;
                }
            }
            contextTokens = estimate.tokens;
        } else {
            contextTokens = directContextTokens;
        }
        if (shouldCompact(contextTokens, contextWindow, settings)) {
            return await this._runAutoCompaction("threshold", false);
        }
        return false;
    }
    async _runAutoCompaction(reason, willRetry) {
        const model = this.model;
        const settings = this.settingsManager.getCompactionSettings(model);
        let abortController;
        let started = false;
        let fromExtension = false;
        let cancelledByExtension = false;
        try {
            if (!model) {
                return false;
            }
            const pathEntries = this.sessionManager.getBranch();
            const preparation = prepareCompaction(pathEntries, settings);
            if (!preparation) {
                return false;
            }
            abortController = new AbortController();
            this._autoCompactionAbortController = abortController;
            started = true;
            this._emit({
                type: "compaction_start",
                reason
            });
            abortController.signal.throwIfAborted();
            let extensionCompaction;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {
                const extensionResult = await this._extensionRunner.emit({
                    type: "session_before_compact",
                    preparation,
                    branchEntries: pathEntries,
                    customInstructions: undefined,
                    reason,
                    willRetry,
                    signal: abortController.signal
                });
                if (extensionResult?.cancel) {
                    cancelledByExtension = true;
                    throw new Error("Compaction cancelled");
                }
                if (extensionResult?.compaction) {
                    extensionCompaction = extensionResult.compaction;
                    fromExtension = true;
                }
            }
            abortController.signal.throwIfAborted();
            let summary;
            let firstKeptEntryId;
            let tokensBefore;
            let usage;
            let details;
            if (extensionCompaction) {
                summary = extensionCompaction.summary;
                firstKeptEntryId = extensionCompaction.firstKeptEntryId;
                tokensBefore = extensionCompaction.tokensBefore;
                usage = extensionCompaction.usage;
                details = extensionCompaction.details;
            } else {
                const compactResult = await this._runDefaultCompaction(preparation, model, undefined, abortController.signal, reason);
                summary = compactResult.summary;
                firstKeptEntryId = compactResult.firstKeptEntryId;
                tokensBefore = compactResult.tokensBefore;
                usage = compactResult.usage;
                details = compactResult.details;
            }
            abortController.signal.throwIfAborted();
            this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
            const newEntries = this.sessionManager.getEntries();
            this._refreshFinalizedContext();
            const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);
            const savedCompactionEntry = newEntries.find((e)=>e.type === "compaction" && e.summary === summary);
            if (this._extensionRunner && savedCompactionEntry) {
                await this._extensionRunner.emit({
                    type: "session_compact",
                    compactionEntry: savedCompactionEntry,
                    fromExtension,
                    reason,
                    willRetry
                });
            }
            const result = {
                summary,
                firstKeptEntryId,
                tokensBefore,
                estimatedTokensAfter,
                usage,
                details
            };
            this._emit({
                type: "compaction_end",
                reason,
                result,
                aborted: false,
                willRetry
            });
            if (willRetry) return true;
            return this.agent.hasQueuedMessages();
        } catch (error) {
            const message = error instanceof Error ? error.message : "compaction failed";
            const aborted = abortController?.signal.aborted === true || cancelledByExtension;
            if (started) {
                const errorMessage = aborted ? undefined : reason === "overflow" ? `Context overflow recovery failed: ${message}` : `Auto-compaction failed: ${message}`;
                this._emit({
                    type: "compaction_end",
                    reason,
                    result: undefined,
                    aborted,
                    willRetry: false,
                    errorMessage
                });
                await this._emitSessionCompactFailed({
                    reason,
                    errorMessage,
                    aborted,
                    willRetry: false,
                    fromExtension
                });
            }
            return false;
        } finally{
            if (this._autoCompactionAbortController === abortController) {
                this._autoCompactionAbortController = undefined;
            }
            this._resolveIdleWaitIfIdle();
        }
    }
    _isRetryableError(message) {
        if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
        return isRetryableAssistantError(message);
    }
    _summarizationRetryCallbacks(source) {
        return {
            onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage)=>{
                this._emit({
                    type: "summarization_retry_scheduled",
                    attempt,
                    maxAttempts,
                    delayMs,
                    errorMessage
                });
            },
            onRetryAttemptStart: ()=>{
                this._emit({
                    type: "summarization_retry_attempt_start",
                    ...source
                });
            },
            onRetryFinished: ()=>{
                this._emit({
                    type: "summarization_retry_finished"
                });
            }
        };
    }
    async _prepareRetry(message) {
        const settings = this.settingsManager.getRetrySettings();
        if (!settings.enabled) {
            return false;
        }
        this._retryAttempt++;
        if (this._retryAttempt > settings.maxRetries) {
            this._retryAttempt--;
            return false;
        }
        const delayMs = retryDelayMs(settings, this._retryAttempt);
        this._emit({
            type: "auto_retry_start",
            attempt: this._retryAttempt,
            maxAttempts: settings.maxRetries,
            delayMs,
            errorMessage: message.errorMessage || "Unknown error"
        });
        this._omitRecoveryAttempt(message);
        this._retryAbortController = new AbortController();
        try {
            await sleep(delayMs, this._retryAbortController.signal);
        } catch  {
            this._finishCancelledRetry();
            return false;
        } finally{
            this._retryAbortController = undefined;
        }
        return true;
    }
    _finishCancelledRetry() {
        if (this._retryAttempt === 0) return;
        const attempt = this._retryAttempt;
        this._retryAttempt = 0;
        this._emit({
            type: "auto_retry_end",
            success: false,
            attempt,
            finalError: "Retry cancelled"
        });
    }
    async _handlePostAgentRun() {
        const message = this._lastAssistantMessage;
        const toolResults = this._lastAssistantToolResults;
        this._lastAssistantMessage = undefined;
        this._lastAssistantToolResults = [];
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (!message) return this.agent.hasQueuedMessages();
        if (this._isRetryableError(message) && await this._prepareRetry(message)) {
            if (this._agentRunAbortRequested) this._finishCancelledRetry();
            this._failedResponse = message;
            return !this._agentRunAbortRequested;
        }
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (message.stopReason === "error" && this._retryAttempt > 0) {
            this._emit({
                type: "auto_retry_end",
                success: false,
                attempt: this._retryAttempt,
                finalError: message.errorMessage
            });
            this._retryAttempt = 0;
        }
        if (await this._checkCompaction(message, true, toolResults)) {
            return !this._agentRunAbortRequested;
        }
        return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
    }
    _omitRecoveryAttempt(message, toolResults = []) {
        const targets = [
            message,
            ...toolResults
        ];
        const targetIds = targets.map((target)=>this._findPersistedMessageEntryId(target));
        const unresolvedProjectedTarget = targets.some((target, index)=>targetIds[index] === undefined && this.agent.state.messages.includes(target));
        if (unresolvedProjectedTarget) {
            throw new Error("Cannot persist recovery omission because a projected message has no source entry");
        }
        for (const targetId of targetIds){
            if (!targetId) continue;
            const editId = this.sessionManager.appendContextEdit(targetId, null);
            const entry = this.sessionManager.getEntry(editId);
            if (entry) this._emit({
                type: "entry_appended",
                entry
            });
        }
        this._refreshFinalizedContext();
    }
}
