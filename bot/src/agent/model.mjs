import { modelConnection, connectionModel, readConnectionCatalog } from './connections.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export function selectedConnection(config, { work, fast = false } = {}) {
  const selection = work?.supervisor;
  const id = selection?.connectionId;
  if (work && !id) throw new Error('This work has no saved supervisor chat model; record the actual model selection before reviewing it.');
  if (id) return { ...modelConnection(config.model, id), ...(selection.modelId ? { model: selection.modelId } : {}),
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}) };
  if (fast && config.model.connectionStore) {
    const catalog = readConnectionCatalog(config.model.connectionStore);
    let saved = {}, environment = '';
    try { saved = JSON.parse(readFileSync(join(dirname(config.model.connectionStore), 'model-credentials.json'), 'utf8')); } catch {}
    try { if (catalog.environmentFile) environment = readFileSync(catalog.environmentFile, 'utf8'); } catch {}
    const ready = item => item.id === catalog.activeId || Boolean(item.allowNoKey || item.apiKey || saved[item.id]?.key ||
      item.apiKeyEnv && (process.env[item.apiKeyEnv] || environment.split(/\r?\n/).some(line => {
        const index = line.indexOf('='); return index > 0 && line.slice(0, index).trim() === item.apiKeyEnv && line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      })));
    const candidates = catalog.connections.filter(item => item.kind === 'api' && ready(item));
    const selected = candidates.find(item => item.id === catalog.fastId) ||
      candidates.find(item => item.id === catalog.activeId && /flash|haiku|mini/i.test(item.model)) ||
      candidates.find(item => /flash|haiku|mini/i.test(item.model));
    if (selected) return modelConnection(config.model, selected.id);
  }
  return modelConnection(config.model);
}
export function modelFor(config, options) { return connectionModel(selectedConnection(config, options)); }
