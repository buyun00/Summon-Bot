// Node.js 24+, no dependencies. Import in your service; no automatic write retry.
export class CodexDesktopClient {
  constructor({ baseUrl = 'http://127.0.0.1:47831' } = {}) { this.baseUrl = baseUrl; }
  async request(route, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const response = await fetch(this.baseUrl + route, {
      method, signal, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || `HTTP ${response.status}`), { status: response.status, response: result });
    return result;
  }
  listThreads() { return this.request('/v1/threads'); }
  state(id, hostId = 'local') { return this.request(`/v1/threads/${encodeURIComponent(id)}/state?hostId=${encodeURIComponent(hostId)}`); }
  createThread(body, idempotencyKey) { return this.request('/v1/threads', { method: 'POST', body, idempotencyKey }); }
  sendMessage(id, message, idempotencyKey) { return this.request(`/v1/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { message }, idempotencyKey }); }
  async *events({ threadId, hostId = 'local', after, signal } = {}) {
    const params = new URLSearchParams();
    if (threadId) { params.set('threadId', threadId); params.set('hostId', hostId); }
    const response = await fetch(`${this.baseUrl}/v1/events?${params}`, { signal, headers: { ...(after != null ? { 'Last-Event-ID': String(after) } : {}) } });
    if (!response.ok) throw new Error(`SSE HTTP ${response.status}: ${await response.text()}`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n'); if (index < 0) break;
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (data) yield JSON.parse(data);
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
