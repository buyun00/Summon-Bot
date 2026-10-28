import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('Set WEBHOOK_SECRET first.');
const seen = new Map();
http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/events') return res.writeHead(404).end();
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const actual = Buffer.from(req.headers['x-webhook-signature'] || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected))) return res.writeHead(401).end();
    const event = JSON.parse(body);
    if (typeof event.id !== 'string' || !Number.isFinite(Date.parse(event.at)) || Math.abs(Date.now() - Date.parse(event.at)) > 15 * 60 * 1000) return res.writeHead(400).end();
    for (const [id, at] of seen) if (Date.now() - at > 15 * 60 * 1000) seen.delete(id);
    if (!seen.has(event.id)) { seen.set(event.id, Date.now()); console.log(event); /* Enqueue bot wakeup here. */ }
    res.writeHead(204).end();
  } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
}).listen(47832, '127.0.0.1', () => console.log('Webhook receiver: http://127.0.0.1:47832/events'));
