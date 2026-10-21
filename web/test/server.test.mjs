import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startWeb } from '../backend/server.mjs';

test('Web forwards authenticated API, streams bytes, rejects private routes, and does not own gateway lifecycle', async t => {
  const received = [];
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url === '/api/attachments/result') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from([0, 1, 255, 25])); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  const web = await startWeb({ port: 0, gatewayUrl, gatewayToken: 'test-gateway-secret' });
  t.after(() => web.close());
  assert.equal((await fetch(web.url)).status, 200);
  const post = await fetch(`${web.url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: web.url }, body: JSON.stringify({ name: '讨论' }) });
  assert.equal(post.status, 200);
  assert.deepEqual(received[0], { url: '/api/rooms', authorization: 'Bearer test-gateway-secret', body: '{"name":"讨论"}' });
  const binary = await fetch(`${web.url}/api/attachments/result`);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0, 1, 255, 25]));
  for (const path of ['/tools', '/mcp', '/internal/bots', '/api/private', '/../../package.json']) assert.equal((await fetch(`${web.url}${path}`)).status, 404);
  assert.equal((await fetch(`${web.url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${web.url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
  await web.close();
  assert.equal((await fetch(`${gatewayUrl}/api/health`)).status, 200);
});
