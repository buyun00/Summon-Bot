import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/server.mjs';

test('HTTP workspace stores messages, rejects cross-site writes and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-http-'));
  const config = { dataDir: dir, database: join(dir, 'relay.sqlite'), port: 0, apiKey: 'unit-test-private-key' };
  const provider = { status: { configured: true, model: 'test-double' }, complete: async () => ({ content: JSON.stringify({ pass: true, actions: [] }) }) };
  const executor = { start() {}, stop() {}, list: () => [], get: () => undefined };
  let app;
  try {
    app = await startServer({ config, provider, executor });
    const request = (path, method = 'GET', body, headers = {}) => fetch(app.url + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await request('/api/health')).status, 200);
    const page = await request('/');
    assert.match(await page.text(), /Relay/);
    const state = await (await request('/api/state')).json();
    assert.ok(state.bots.length >= 3);
    assert.ok(!JSON.stringify(state).includes(config.apiKey));
    const denied = await request('/api/rooms', 'POST', { name: 'foreign', kind: 'group', members: [] }, { Origin: 'https://unrelated.example' });
    assert.equal(denied.status, 403);
    await request('/api/bots/bot-engineer', 'PATCH', { status: 'paused', avatar: { shape: 'cloud', color: '#13B7A2' } });
    const roomResponse = await request('/api/rooms', 'POST', { name: 'HTTP persistence', kind: 'group', members: ['user', 'bot-engineer'] });
    const room = await roomResponse.json();
    assert.equal(roomResponse.status, 200, JSON.stringify(room));
    assert.ok(room.id);
    const unicodePayload = Buffer.from(JSON.stringify({ name: '中文分片保真', kind: 'group', members: ['bot-engineer'] }));
    const split = unicodePayload.indexOf(Buffer.from('中')) + 1;
    const unicodeRoom = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(app.url + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.write(unicodePayload.subarray(0, split));
      setTimeout(() => outgoing.end(unicodePayload.subarray(split)), 20);
    });
    assert.equal(unicodeRoom.name, '中文分片保真');
    const first = await (await request(`/api/rooms/${room.id}/messages`, 'POST', { content: 'Persistent source', clientId: 'http-message-one' })).json();
    const retry = await (await request(`/api/rooms/${room.id}/messages`, 'POST', { content: 'Persistent source', clientId: 'http-message-one' })).json();
    assert.equal(first.id, retry.id);
    const edited = await request(`/api/rooms/${room.id}`, 'PATCH', { name: '编辑后的群名称', members: ['user', 'bot-engineer', 'bot-qa'] });
    assert.equal(edited.status, 200);
    const malformed = await fetch(app.url + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    await app.close();
    app = await startServer({ config, provider, executor });
    const restored = await (await fetch(app.url + `/api/rooms/${room.id}/messages`)).json();
    assert.equal(restored.messages.filter(m => m.id === first.id).length, 1);
    assert.equal(restored.room.name, '编辑后的群名称');
    assert.ok(restored.room.members.includes('bot-qa'));
    const restartedState = await (await request('/api/state')).json();
    assert.deepEqual(restartedState.bots.find(bot => bot.id === 'bot-engineer').avatar, { shape: 'cloud', color: '#13B7A2', image: '' });
    assert.equal(restartedState.rooms.find(item => item.id === room.id).lastMessage.id, first.id);
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
