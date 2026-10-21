export const NO_RETRY = Object.freeze({ enabled: false, maxRetries: 0, baseDelayMs: 0 });
export function modelFor(config) {
  const { model, provider, baseUrl, contextWindow, maxTokens } = config.model;
  if (!Number.isInteger(contextWindow) || contextWindow < 4096 || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens >= contextWindow) throw new Error('Invalid model context/output budgets');
  return { id: model, name: model, api: 'openai-completions', provider, baseUrl, reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
}
export function contextSettings(config, model) {
  const reserveTokens = config.agentReserveTokens ?? Math.max(model.maxTokens + 1024, Math.min(16384, Math.floor(model.contextWindow / 4)));
  const keepRecentTokens = config.agentKeepRecentTokens ?? Math.min(20000, Math.floor((model.contextWindow - reserveTokens) / 3));
  if (![reserveTokens, keepRecentTokens].every(Number.isInteger) || reserveTokens < model.maxTokens || reserveTokens >= model.contextWindow || keepRecentTokens < 128 || keepRecentTokens >= model.contextWindow - reserveTokens) throw new Error('Invalid context compaction budgets');
  return { enabled: config.agentCompaction !== false, reserveTokens, keepRecentTokens };
}
