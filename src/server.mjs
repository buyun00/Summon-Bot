import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, safeError } from './config.mjs';
import { DeepSeekProvider } from './provider.mjs';
import { Store } from './store.mjs';
import { SocialRuntime } from './social.mjs';
import { CodexExecutor } from './codex.mjs';
import { BotAgentRuntime } from './agent.mjs';
import { ExecutionLock } from './execution-lock.mjs';

export async function startServer(options = {}) {
  const config = loadConfig(options.config);
  const store = options.store || new Store(config.database);
  const provider = options.provider || new DeepSeekProvider(config);
  const clients = new Set();
  const emit = (type = 'change', payload = {}) => {
    const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const client of clients) client.write(line);
  };
  let social;
  const executionLock = new ExecutionLock();
  const agentRuntime = options.agentRuntime ?? (typeof provider.stream === 'function' ? new BotAgentRuntime({ store, provider, config, emit, executionLock }) : null);
  const executor = options.executor || new CodexExecutor({ store, emit, defaultCwd: config.defaultCwd, codexPath: config.codexPath,
    executionLock,
    consult: (...args) => social.consult(...args), onResult: work => social.workUpdate(work) });
  social = new SocialRuntime({ store, provider, emit, agentRuntime, defaultCwd: config.defaultCwd, createWork: input => executor.create(input) });
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, service: 'relay-bot', model: 'deepseek-flash' });
      if (req.method === 'GET' && path === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: {"type":"connected"}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (path.startsWith('/api/')) {
        let body = {};
        if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
          // Local browser writes must be JSON from this service, not a cross-site form.
          if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '只接受本地工作台请求' });
          if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '请求需要 application/json' });
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) return json(res, 413, { error: '请求超过 1 MB' });
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'JSON 格式错误' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: '请求应为 JSON 对象' });
        }
        if (req.method === 'GET' && path === '/api/state') return json(res, 200, { ...social.state(), works: executor.list(), agentRuns: agentRuntime?.list() || [], provider: provider.status, defaultCwd: config.defaultCwd });
        const agentMatch = path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(cancel))?$/);
        if (agentMatch) {
          const run = agentRuntime?.get(agentMatch[1]);
          if (!run) return json(res, 404, { error: '找不到此 Bot 执行记录' });
          if (req.method === 'GET' && !agentMatch[2]) return json(res, 200, run);
          if (req.method === 'POST' && agentMatch[2] === 'cancel') return json(res, 200, await agentRuntime.cancel(run.id));
        }
        if (req.method === 'POST' && path === '/api/works') {
          if (!store.get('bots', body.botId) || !store.get('rooms', body.roomId)) return json(res, 400, { error: '请选择有效的成员和来源会话' });
          return json(res, 200, await executor.create(body));
        }
        const workMatch = path.match(/^\/api\/works\/([^/]+)(?:\/(cancel|resume|answer))?$/);
        if (workMatch) {
          const work = executor.get(workMatch[1]);
          if (!work) return json(res, 404, { error: '找不到此工作' });
          if (req.method === 'GET' && !workMatch[2]) return json(res, 200, work);
          if (req.method === 'POST' && workMatch[2]) return json(res, 200, await executor[workMatch[2]](work.id, body));
        }
        const result = await social.handle(req.method, path, body, url.searchParams);
        if (result !== undefined) return json(res, 200, result);
        return json(res, 404, { error: '找不到接口' });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/avatars.js': ['avatars.js', 'text/javascript'], '/motion.js': ['motion.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !assets[path]) { res.writeHead(404); res.end('Not found'); return; }
      const [file, type] = assets[path];
      const contents = await readFile(join(config.root, 'public', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(contents);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || error.statusCode || 400, { error: safeError(error, config) });
      else res.end();
    }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolveReady); });
  await executor.start?.();
  agentRuntime?.start();
  social.start();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 20000);
  heartbeat.unref();
  let stopping;
  const close = () => stopping ||= (async () => {
    clearInterval(heartbeat);
    provider.stop?.();
    await social.stop();
    await executor.stop();
    for (const client of clients) client.end();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close();
  })();
  return { server, store, social, executor, agentRuntime, provider, config, close, url: `http://${config.host}:${server.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startServer();
  console.log(`Relay Bot 已启动：${app.url}\n社交模型：deepseek-flash\n按 Ctrl+C 停止。`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
