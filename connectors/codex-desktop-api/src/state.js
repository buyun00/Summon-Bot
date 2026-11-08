const unsafe = new Set(['__proto__', 'constructor', 'prototype']);

// Codex desktop uses Immer-style paths and add/remove/replace operations.
// Only apply after checking baseRevision; a gap requires a new snapshot.
export function applyPatches(state, patches) {
  let next = state;
  for (const patch of patches) {
    if (!['add', 'remove', 'replace'].includes(patch.op) || !Array.isArray(patch.path) || patch.path.some(key => (typeof key !== 'string' && !Number.isInteger(key)) || unsafe.has(String(key)))) throw new Error('Unsupported or unsafe desktop patch.');
    if (!patch.path.length) { if (patch.op === 'remove') throw new Error('Cannot remove root.'); next = patch.value; continue; }
    let parent = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw new Error('Patch parent missing.');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('Invalid patch parent.');
    const key = patch.path.at(-1);
    if (Array.isArray(parent) && key !== 'length') {
      if (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) > parent.length) throw new Error('Invalid patch index.');
      if (patch.op === 'remove') parent.splice(Number(key), 1);
      else if (patch.op === 'add') parent.splice(Number(key), 0, patch.value);
      else parent[key] = patch.value;
    } else if (patch.op === 'remove') delete parent[key];
    else parent[key] = patch.value;
  }
  return next;
}

export function conversationTurns(state) {
  const history = state.turnHistory?.history;
  if (history?.entitiesByKey) {
    const ordered = history.islands?.flatMap(island => island.entries || []).map(entry => history.entitiesByKey[entry.entityKey ?? entry.key]).filter(Boolean);
    return ordered?.length ? ordered : Object.values(history.entitiesByKey);
  }
  return state.turns || [];
}

function bounded(text, limit = 20000) {
  if (typeof text !== 'string') return undefined;
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(-limit), truncated: true, originalChars: text.length, window: 'tail' };
}
export function normalizeItem(item) {
  // Only forward displayed messages and tool activity; do not expose reasoning items.
  if (!item || item.type === 'reasoning') return null;
  const result = { id: item.id, type: item.type };
  for (const key of ['status', 'phase', 'command', 'cwd', 'exitCode', 'durationMs', 'tool', 'server', 'namespace', 'name']) {
    if (item[key] != null) result[key] = typeof item[key] === 'string' ? item[key].slice(0, 20000) : item[key];
  }
  const text = item.text ?? item.message ?? (Array.isArray(item.content) ? item.content.filter(x => ['text', 'input_text', 'output_text'].includes(x.type)).map(x => x.text).join('\n') : undefined);
  if (typeof text === 'string') result.text = bounded(text);
  const output = item.aggregatedOutput ?? item.output?.text ?? (typeof item.output === 'string' ? item.output : undefined);
  if (output != null) result.output = bounded(output);
  if (item.error) result.error = typeof item.error === 'string' ? item.error.slice(0, 2000) : item.error;
  return result;
}

export function normalizeState(state, { revision, observedAt, connected = true, itemOrigins = new Map() } = {}) {
  const turns = conversationTurns(state);
  const current = turns.findLast(turn => turn.status === 'inProgress') ?? turns.at(-1);
  const runtime = state.threadRuntimeStatus ?? { type: current?.status === 'inProgress' ? 'active' : 'unknown' };
  const flags = runtime.activeFlags || [];
  let status = runtime.type;
  if (flags.some(flag => /approval|input/i.test(String(flag))) || state.requests?.length) status = 'waiting_for_input';
  if (!connected) status = 'unknown';
  // A native snapshot can contain old items in a resumed turn. First known
  // turn ownership is immutable; snapshots never manufacture a new item time.
  for (const turn of turns) for (const item of turn.items || []) {
    if (!item?.id || itemOrigins.has(item.id)) continue;
    const rawTime = item.createdAt ?? item.timestamp ?? item.startedAt;
    const parsed = typeof rawTime === 'number' ? new Date(rawTime) : typeof rawTime === 'string' ? new Date(rawTime) : null;
    itemOrigins.set(item.id, { threadId: state.id, turnId: item.turnId || turn.turnId || turn.id,
      occurredAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null, firstObservedAt: observedAt || null });
  }
  const currentId = current?.turnId ?? current?.id;
  const items = (current?.items || []).map(item => {
    const normalized = normalizeItem(item), origin = itemOrigins.get(item?.id);
    return normalized && origin?.turnId === currentId ? { ...normalized, ...origin } : null;
  }).filter(Boolean);
  return {
    threadId: state.id, hostId: state.hostId || 'local', title: state.title, cwd: state.cwd,
    status, runtimeStatus: runtime, observedAt, revision, source: 'desktop_ipc', stale: !connected,
    model: state.latestModel, reasoningEffort: state.latestReasoningEffort,
    currentTurn: current ? { id: current.turnId ?? current.id, status: current.status, startedAt: current.turnStartedAtMs, durationMs: current.durationMs, error: current.error ?? null } : null,
    pendingRequests: (state.requests || []).map(request => ({ id: request.id, type: request.type ?? request.method })),
    items: items.slice(-50), partialItems: items.length > 50,
    historyComplete: state.turnHistory?.history?.isComplete ?? state.turnsPagination?.hasLoadedOldest ?? false,
  };
}
