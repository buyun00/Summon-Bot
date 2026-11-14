import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createRedactor(config) {
  const model = config.model ?? config;
  const secrets = new Set();
  const visit = (value, key = '') => {
    if (typeof value === 'string' && /token|apiKey|authorization|password|secret|^(?:key|access|refresh)$/i.test(key) && value.length >= 8) {
      secrets.add(value);
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        if (childKey === 'headersEnv' && child && typeof child === 'object') {
          for (const name of Object.values(child)) if (process.env[name]) secrets.add(process.env[name]);
        }
        if (childKey === 'env' && typeof child === 'string' && process.env[child]) secrets.add(process.env[child]);
        visit(child, childKey);
      }
    }
  };
  visit(config);
  if (model.apiKeyEnv && process.env[model.apiKeyEnv]) secrets.add(process.env[model.apiKeyEnv]);
  const files = model.connectionStore ? ['deployment.json', 'model-credentials.json'].map(name => resolve(dirname(model.connectionStore), name)) : [];
  function refresh() {
    for (const path of files) {
      try { visit(JSON.parse(readFileSync(path, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  refresh();
  return value => {
    if (value === undefined) return undefined;
    refresh();
    let text = JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return JSON.parse(text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]'));
  };
}
