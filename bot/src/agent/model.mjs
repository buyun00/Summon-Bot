export function modelFor(config) {
  const { model, provider, baseUrl, contextWindow, maxTokens } = config.model;
  if (!Number.isInteger(contextWindow) || contextWindow < 4096 || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens >= contextWindow) throw new Error('Invalid model context/output budgets');
  return { id: model, name: model, api: 'openai-completions', provider, baseUrl, reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
}
