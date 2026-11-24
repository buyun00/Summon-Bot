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
    let readable = true;
    for (const path of files) {
      try {
        const source = JSON.parse(readFileSync(path, 'utf8'));
        if (source && typeof source === 'object' && !Array.isArray(source)) visit(source);
        else readable = false;
      } catch (error) { if (error.code !== 'ENOENT') readable = false; }
    }
    return readable;
  }
  function redactString(input) {
    let text = input;
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text
      .replace(/\b(Bearer|Basic)\s+[^\s,"'\\}]+/gi, '$1 [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/\b(?:sk-|xai-|ghp_|gho_|AIza)[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
      .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s,"'\\}]+/gi, '$1[redacted]')
      .replace(/(["']?(?:access_token|refresh_token|api_key|apiKey|password|passwd|secret|cookie)["']?\s*[:=]\s*["']?)[^\s,"'\\}]+/gi, '$1[redacted]');
  }
  const sensitiveKeyPattern = /token|api[_-]?key|authorization|password|passwd|secret|cookie|credential|private[_-]?key|^(?:key|access|refresh)$/i;
  const tokenMetricKeyPattern = /(?:^(?:input|output|total|prompt|completion|cached|cache[_-]?(?:hit|miss|known[_-]?input)?|reasoning|max|min|avg|reserve|context|remaining|used|billed)[_-]?tokens?$|token[_-]?(?:count|limit|budget|usage|window|rate|price|cost)$)/i;
  function redactNode(value, key = '') {
    if (key && sensitiveKeyPattern.test(key) && !tokenMetricKeyPattern.test(key) && (typeof value === 'string' || typeof value === 'number')) return '[redacted]';
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(item => redactNode(item, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = redactNode(v, k);
      return out;
    }
    return value;
  }
  function redact(value) {
    if (value === undefined) return undefined;
    return redactNode(JSON.parse(JSON.stringify(value)));
  }
  const clean = value => { refresh(); return redact(value); };
  clean.error = (value, message = 'The Summon host could not complete this operation') => {
    if (refresh()) return redact(value);
    if (typeof value === 'string') return message;
    const { status, code } = value;
    return redact({ status, code, message });
  };
  return clean;
}
