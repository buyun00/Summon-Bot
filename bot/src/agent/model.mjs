import { DEFAULT_COMPACTION_SETTINGS } from '../pi/core/compaction/compaction.mjs';
export const DEFAULT_RETRY = Object.freeze({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 });
export function modelFor(config) {
  const { model, provider, baseUrl, contextWindow, maxTokens } = config.model;
  if (!Number.isInteger(contextWindow) || contextWindow < 4096 || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens >= contextWindow) throw new Error('Invalid model context/output budgets');
  return { id: model, name: model, api: 'openai-completions', provider, baseUrl, reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
}
export function contextSettings(config, model) {
  const reserveTokens = config.agentReserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const keepRecentTokens = config.agentKeepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
  if (![reserveTokens, keepRecentTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid context compaction budgets');
  return { enabled: config.agentCompaction !== false, reserveTokens, keepRecentTokens };
}
