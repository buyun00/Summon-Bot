import { randomUUID } from 'node:crypto';

export async function requestBot(contact, path, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
  const base = new URL(contact.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Bot contact URL');
  const response = await fetch(new URL(path, base), { method, redirect: 'error',
    headers: { authorization: `Bearer ${contact.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error?.message || `Bot HTTP ${response.status}`), { status: response.status, code: value.error?.code });
  return value;
}

export function sendMessage(contact, envelope, options = {}) {
  return requestBot(contact, '/messages', { ...options, method: 'POST', body: { id: randomUUID(), kind: 'request', to: contact.botId, ...envelope } });
}

export async function waitForTask(contact, taskId, { signal, timeoutMs = 600000, intervalMs = 100 } = {}) {
  const controller = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller]) : controller;
  for (;;) {
    const task = await requestBot(contact, `/tasks/${encodeURIComponent(taskId)}`, { signal: combined });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
    await new Promise((resolve, reject) => {
      combined.throwIfAborted();
      const done = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); reject(combined.reason); };
      const timer = setTimeout(done, intervalMs); combined.addEventListener('abort', abort, { once: true });
    });
  }
}
