import { connectionModel, modelConnection, readConnectionCatalog, resolveBotModelSelection } from './connections.mjs';
import { runtimeFailure } from '../storage/runtime-records.mjs';

function selectedConnection(config, selection, purpose) {
  const resolved = config.connectionStore && selection && (selection.mode || !selection.connection_id)
    ? resolveBotModelSelection(readConnectionCatalog(config.connectionStore), selection, purpose)
    : selection;
  if (typeof resolved?.connection_id !== 'string' || !resolved.connection_id)
    throw runtimeFailure('connection_unconfigured', 'An explicit model connection is required', 409);
  const current = modelConnection(config, resolved.connection_id);
  const model = resolved.id ?? current.model;
  const thinkingLevel = resolved.thinking_level !== undefined ? resolved.thinking_level : (current.thinkingLevel ?? null);
  return { ...current, model, thinkingLevel };
}

// Bind the actual model and routing facts. Credential material remains in the host catalog.
export function bindModel(config, selection, purpose = 'conversation') {
  if (!selection) throw runtimeFailure('connection_unconfigured', 'An explicit model connection is required', 409);
  const connection = selectedConnection(config, selection, purpose);
  const model = connectionModel(connection);
  return {
    connection_id: connection.id, model_id: model.id, provider: connection.provider ?? null,
    kind: connection.kind, api: model.api, base_url: model.baseUrl ?? null,
    reasoning: connection.reasoning !== false, thinking_level: connection.thinkingLevel,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens, output_token_limit: model.outputTokenLimit,
  };
}

export function boundModel(config, binding) {
  const connection = modelConnection(config, binding.connection_id);
  const actual = connectionModel({ ...connection, model: binding.model_id, reasoning: binding.reasoning,
    thinkingLevel: binding.thinking_level, contextWindow: binding.context_window, maxTokens: binding.max_tokens });
  if (connection.kind !== binding.kind || (connection.provider ?? null) !== binding.provider ||
      actual.api !== binding.api || (actual.baseUrl ?? null) !== binding.base_url) {
    throw runtimeFailure('model_binding_changed', 'The bound model connection is no longer available for this execution', 403);
  }
  return { ...actual, maxTokens: binding.max_tokens, outputTokenLimit: binding.output_token_limit };
}

export function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}
