import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Run by the relay Bot's ordinary command tool. No server or independent executor.
async function main() {
  const file = resolve(process.argv[2] || 'request.json');
  const request = JSON.parse(await readFile(file, 'utf8'));
  const config = JSON.parse(await readFile('D:/Relay-Bot-data/connectors/codex-desktop-api/config.json', 'utf8'));
  const id = encodeURIComponent(request.threadId || '');
  const routes = {
    projects: ['GET', '/v1/projects'],
    create: ['POST', '/v1/threads'],
    send: ['POST', `/v1/threads/${id}/messages`],
    state: ['GET', `/v1/threads/${id}/state`],
    history: ['GET', `/v1/threads/${id}/messages?limit=3&includeOutputs=true&maxOutputCharsPerItem=6000`],
    interrupt: ['POST', `/v1/threads/${id}/interrupt`],
    operation: ['GET', `/v1/operations/${encodeURIComponent(request.operationKey || '')}`],
  };
  const route = routes[request.action];
  if (!route || (['send', 'state', 'history', 'interrupt'].includes(request.action) && !id)) throw new Error('Invalid action or missing threadId');
  if (request.action === 'operation' && !request.operationKey) throw new Error('operationKey is required');
  const [method, path] = route;
  const outputFile = `${file}.result.json`;
  const write = method !== 'GET';
  let record;
  if (write) {
    try { record = JSON.parse(await readFile(outputFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (record) {
      if (JSON.stringify(record.request) !== JSON.stringify(request)) throw new Error('Request file already used. Use a new file for a new operation.');
      console.log(JSON.stringify(record));
      return; // An uncertain mutation is never automatically replayed.
    }
    record = { request, operationKey: request.operationKey || randomUUID(), outcome: 'unknown', startedAt: new Date().toISOString() };
    await writeFile(outputFile, JSON.stringify(record, null, 2), { flag: 'wx' });
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.auth?.bearerToken) headers.Authorization = `Bearer ${config.auth.bearerToken}`;
  if (write) headers['Idempotency-Key'] = record.operationKey;
  try {
    const response = await fetch(`http://127.0.0.1:47831${path}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(65000),
      ...(write ? { body: JSON.stringify(request.body || {}) } : {}),
    });
    const result = await response.json();
    const output = { ...record, outcome: response.ok ? 'received' : 'error', httpStatus: response.status, result, observedAt: new Date().toISOString() };
    await writeFile(outputFile, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    // Keep the persisted operation key for reconciliation; no credential output.
    console.log(JSON.stringify({ ...record, outcome: 'unknown', error: error.name, message: 'API request did not yield a confirmed response. Read operation using the saved operationKey.', outputFile }));
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
