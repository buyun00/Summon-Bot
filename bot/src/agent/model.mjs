import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { connectionModel, modelConnection } from './connections.mjs';
import { runtimeFailure } from '../storage/runtime-records.mjs';

function selectedConnection(config, selection) {
  const current = modelConnection(config, selection.connection_id);
  const model = selection.id ?? current.model;
  const thinkingLevel = selection.thinking_level ?? current.thinkingLevel ?? 'high';
  return { ...current, model, thinkingLevel };
}

// Bind the actual model and routing facts. Credential material remains in the host catalog.
export function bindModel(config, selection) {
  if (typeof selection?.connection_id !== 'string' || !selection.connection_id)
    throw runtimeFailure('connection_unconfigured', 'An explicit model connection is required', 409);
  const connection = selectedConnection(config, selection);
  const model = connectionModel(connection);
  const requested = connection.reasoning === false ? 'off' : connection.thinkingLevel;
  const explicit = selection.thinking_level;
  const thinking = clampThinkingLevel(model, requested);
  if (explicit && (thinking !== requested || model.thinkingLevelMap?.[thinking] === null))
    throw runtimeFailure('unsupported_thinking_level', `Model ${model.id} does not support ${requested}`, 400);
  return {
    connection_id: connection.id, model_id: model.id, provider: connection.provider ?? null,
    kind: connection.kind, api: model.api, base_url: model.baseUrl ?? null,
    reasoning: connection.reasoning !== false, thinking_level: thinking,
    require_effort: Boolean(explicit), context_window: model.contextWindow,
    max_tokens: model.maxTokens, output_token_limit: model.outputTokenLimit,
  };
}

export function boundModel(config, binding) {
  const connection = modelConnection(config, binding.connection_id);
  const actual = connectionModel({ ...connection, model: binding.model_id, reasoning: binding.reasoning,
    thinkingLevel: binding.thinking_level, contextWindow: binding.context_window });
  if (connection.kind !== binding.kind || (connection.provider ?? null) !== binding.provider ||
      actual.api !== binding.api || (actual.baseUrl ?? null) !== binding.base_url) {
    throw runtimeFailure('model_binding_changed', 'The bound model connection is no longer available for this execution', 403);
  }
  return { ...actual, maxTokens: binding.max_tokens, outputTokenLimit: binding.output_token_limit };
}
