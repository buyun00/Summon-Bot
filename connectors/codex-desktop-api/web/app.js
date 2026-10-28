import { GROUPS, operationsFromSpec, defaultBody, defaultValues, buildRequest, curlExample, SseDecoder } from './model.js';

const $ = id => document.getElementById(id);
const states = new Map();
let operations = [], selectedId = 'GET /healthz', lastOperationKey = '', lastTurnId = '', toastTimer;
const labels = { threadId: '对话 ID', hostId: '主机 ID', limit: '数量', status: '状态筛选', cursor: '分页游标', after: '事件续读游标', includeOutputs: '包含工具输出', maxOutputCharsPerItem: '单项输出字符上限', key: '操作幂等键', 'Idempotency-Key': '幂等键', 'Last-Event-ID': '事件续读请求头' };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const operation = id => operations.find(item => item.id === id);

function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200); }
function stateFor(op) {
  if (!states.has(op.id)) {
    const values = defaultValues(op);
    if (op.parameters.some(p => p.name === 'threadId')) values.threadId = $('target-thread').value.trim();
    if (op.parameters.some(p => p.name === 'hostId')) values.hostId = $('target-host').value.trim() || 'local';
    if (op.mutation) values['Idempotency-Key'] = crypto.randomUUID();
    if (op.path.includes('{key}')) values.key = lastOperationKey;
    states.set(op.id, { values, body: JSON.stringify(defaultBody(op, lastTurnId), null, 2), status: 'idle', attempted: false, events: [], totalEvents: 0 });
  }
  return states.get(op.id);
}
function renderNav() {
  const filter = $('filter').value.trim().toLowerCase(), nav = $('endpoint-nav'); nav.replaceChildren();
  for (const group of GROUPS) {
    const entries = operations.filter(op => op.group === group && `${op.title} ${op.path} ${op.method}`.toLowerCase().includes(filter));
    if (!entries.length) continue;
    const section = el('div', 'nav-group'); section.append(el('p', 'nav-group-title', group));
    for (const op of entries) {
      const state = states.get(op.id);
      const button = el('button', `endpoint-button${op.id === selectedId ? ' selected' : ''}`);
      button.type = 'button'; button.dataset.operation = op.id;
      button.setAttribute('aria-label', `${op.method} ${op.title}`);
      if (op.id === selectedId) button.setAttribute('aria-current', 'page');
      button.title = `${op.method} ${op.path}`;
      button.append(el('span', `method ${op.method.toLowerCase()}`, op.method), el('span', 'nav-title', op.title));
      const dot = el('i', `dot ${state?.status === 'error' ? 'error' : state?.busy ? 'busy' : state?.attempted && state?.ok ? 'ok' : ''}`);
      dot.title = state?.busy ? '请求中' : state?.attempted ? state.ok ? '请求成功' : '请求失败' : '未测试'; button.append(dot);
      button.addEventListener('click', () => select(op.id)); section.append(button);
    }
    nav.append(section);
  }
  $('endpoint-count').textContent = String(operations.length);
  $('tested-count').textContent = `${[...states.values()].filter(state => state.attempted).length} / ${operations.length}`;
}
function select(id) {
  if (!operation(id)) return;
  selectedId = id;
  renderNav(); renderForm(); renderResponse();
}
function renderForm() {
  const op = operation(selectedId), state = stateFor(op);
  $('operation-method').textContent = op.method; $('operation-method').className = `method ${op.method.toLowerCase()}`;
  $('operation-path').textContent = op.path; $('operation-title').textContent = op.title; $('operation-description').textContent = op.description;
  const fields = $('parameter-fields'); fields.replaceChildren();
  if (!op.parameters.length && !op.bodySchema) fields.append(el('div', 'no-params', '这个接口不需要额外参数。'));
  for (const parameter of op.parameters) {
    const row = el('div', 'field'), label = el('label', 'field-label');
    const inputId = `param-${parameter.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
    label.htmlFor = inputId;
    label.append(el('span', '', parameter.name), el('small', parameter.required ? 'required' : '', parameter.required ? '必填' : '选填'));
    let input;
    if (parameter.schema?.type === 'boolean') {
      input = el('select');
      for (const value of ['', 'true', 'false']) { const option = el('option', '', value || '使用默认值'); option.value = value; input.append(option); }
    } else {
      input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      if (parameter.schema?.type === 'integer') input.inputMode = 'numeric';
      input.placeholder = labels[parameter.name] || parameter.name;
    }
    input.id = inputId; input.dataset.parameter = parameter.name; input.value = state.values[parameter.name] ?? '';
    input.setAttribute('aria-label', `参数 ${parameter.name}`);
    input.addEventListener('input', () => { state.values[parameter.name] = input.value; updatePreview(); });
    if (parameter.name === 'Idempotency-Key') {
      const fresh = el('button', 'text-button field-action', '生成新键'); fresh.type = 'button';
      fresh.addEventListener('click', () => { input.value = state.values[parameter.name] = crypto.randomUUID(); updatePreview(); }); label.append(fresh);
    }
    if (parameter.name === 'key' && lastOperationKey) {
      const recent = el('button', 'text-button field-action', '使用上次操作'); recent.type = 'button'; recent.addEventListener('click', () => { input.value = state.values.key = lastOperationKey; updatePreview(); }); label.append(recent);
    }
    row.append(label, input);
    const hint = parameter.name === 'hostId' ? '本机使用 local。' : parameter.name === 'Idempotency-Key' ? '超时重试请保留此键，避免重复执行。' : parameter.schema?.maximum != null ? `范围：${parameter.schema.minimum ?? 0}–${parameter.schema.maximum}` : parameter.name === 'threadId' && op.stream ? '留空时订阅服务当前监控的对话。' : null;
    if (hint) row.append(el('p', 'field-help', hint));
    fields.append(row);
  }
  $('body-container').hidden = !op.bodySchema; $('request-body').value = state.body;
  $('mutation-note').hidden = !op.mutation;
  $('request-hint').textContent = op.stream ? 'SSE · 持续连接' : '本机直连';
  $('form-error').hidden = true; updateButtons(); updatePreview();
}
function updateButtons() {
  const op = operation(selectedId), state = stateFor(op);
  $('send').disabled = !!state.busy;
  $('send').textContent = state.busy ? op.stream ? '正在订阅…' : '请求中…' : op.stream ? '开始订阅 ↗' : '发送请求 ↗';
  $('stop-stream').hidden = !(op.stream && state.busy);
}
function updatePreview() {
  const op = operation(selectedId), state = stateFor(op);
  try { $('curl-preview').textContent = curlExample(authorizedRequest(op, state.values, state.body), location.origin); }
  catch (error) { $('curl-preview').textContent = `补齐参数后显示完整请求。\n${error.message}`; }
}
function applyTarget(silent = false) {
  const threadId = $('target-thread').value.trim(), hostId = $('target-host').value.trim() || 'local';
  for (const op of operations) {
    const state = stateFor(op);
    if (state.busy) continue;
    if (op.parameters.some(parameter => parameter.name === 'threadId')) state.values.threadId = threadId;
    if (op.parameters.some(parameter => parameter.name === 'hostId')) state.values.hostId = hostId;
  }
  renderForm();
  if (!silent) toast(threadId ? '测试目标已应用到接口参数' : '已清空测试目标');
}
function showFormError(message, id = selectedId) {
  if (id !== selectedId) { toast(message); return; }
  $('form-error').textContent = message; $('form-error').hidden = false;
}
function responseActions(op, state) {
  const container = $('response-actions'); container.replaceChildren();
  const action = (label, fn) => { const button = el('button', 'result-action', label); button.type = 'button'; button.addEventListener('click', fn); container.append(button); };
  if (op.mutation && state.sentKey) action('查询这次操作', () => { lastOperationKey = state.sentKey; const target = operation('GET /v1/operations/{key}'); stateFor(target).values.key = state.sentKey; select(target.id); });
  if (!state.ok || !state.data || op.stream) return;
  const data = state.data;
  const adopt = (threadId, hostId = 'local') => { $('target-thread').value = threadId; $('target-host').value = hostId; applyTarget(true); toast('已设为测试目标'); };
  if (data.threadId) action('使用返回的对话 ID', () => adopt(data.threadId, data.hostId));
  else if (data.thread?.id) action('使用这个对话', () => adopt(data.thread.id, data.thread.hostId));
  const rows = [...(data.pinnedThreads || []), ...(data.threads || []), ...(data.archivedThreads || [])];
  const unique = [...new Map(rows.filter(row => row.id || row.threadId).map(row => [row.id || row.threadId, row])).values()];
  for (const row of unique.slice(0, 8)) action(`选择：${row.title || row.name || row.id || row.threadId}`, () => adopt(row.id || row.threadId, row.hostId));
  if (data.currentTurn?.id) action('将回合 ID 填入中断接口', () => {
    lastTurnId = data.currentTurn.id;
    const interrupt = operation('POST /v1/threads/{threadId}/interrupt'), target = stateFor(interrupt);
    target.body = JSON.stringify({ expectedTurnId: lastTurnId }, null, 2); target.values.threadId = data.threadId; target.values.hostId = data.hostId || 'local';
    select(interrupt.id); toast('仅填入参数，尚未执行中断');
  });
  if (data.page?.nextCursor) action('填入下一页游标', () => { state.values.cursor = data.page.nextCursor; renderForm(); toast('游标已填入，点击发送读取下一页'); });
}
function renderResponse() {
  const op = operation(selectedId), state = stateFor(op);
  $('response-status').className = `status-pill ${state.busy ? 'busy' : state.attempted ? state.ok ? 'ok' : 'error' : ''}`;
  $('response-status').textContent = state.busy ? op.stream && state.httpStatus ? `HTTP ${state.httpStatus} · 订阅中` : '请求中' : state.label || '尚未发送';
  $('response-time').textContent = state.elapsed != null ? `${Math.round(state.elapsed)} ms` : '—';
  $('response-size').textContent = state.bytes != null ? `${(state.bytes / 1024).toFixed(1)} KB` : '';
  $('response-empty').hidden = !!(state.attempted || state.busy);
  $('response-json').hidden = !(state.attempted && !op.stream) && !(state.attempted && !state.ok && op.stream);
  $('stream-output').hidden = !(op.stream && (state.busy || state.totalEvents || state.ok));
  $('response-json').textContent = state.responseText?.slice(0, 1500000) || '';
  $('copy-response').disabled = !state.responseText && !state.events.length;
  $('response-headers').hidden = !state.headers;
  $('headers-json').textContent = state.headers ? JSON.stringify(state.headers, null, 2) : '';
  responseActions(op, state);
  if (op.stream) {
    $('stream-count').textContent = `${state.totalEvents} 条事件${state.totalEvents > 100 ? ' · 显示最近 100 条' : ''}`;
    $('reuse-cursor').disabled = state.lastEventId == null;
    const list = $('event-list'), nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    list.replaceChildren();
    if (!state.events.length) list.append(el('p', 'stream-empty', state.busy ? '等待事件…' : '事件会实时显示在这里。'));
    for (const event of state.events) {
      const entry = el('details', 'event-entry');
      entry.append(el('summary', '', `${event.type}${event.id ? ` · #${event.id}` : ''}`));
      const text = event.value?.data?.delta;
      if (text) { entry.open = true; entry.append(el('p', '', text)); }
      entry.append(el('pre', '', JSON.stringify(event.value, null, 2).slice(0, 60000))); list.append(entry);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  updateButtons();
}
function refresh(id) { renderNav(); if (id === selectedId) renderResponse(); }
async function run(id) {
  const op = operation(id), state = stateFor(op);
  if (state.busy) return { ok: false };
  let request;
  try { request = authorizedRequest(op, state.values, state.body); }
  catch (error) { showFormError(error.message, id); return { ok: false }; }
  if (id === selectedId) $('form-error').hidden = true;
  const headers = { ...request.headers, ...(request.body ? { 'Content-Type': 'application/json' } : {}) };
  const controller = new AbortController(), started = performance.now();
  state.busy = true; state.status = 'busy'; state.controller = controller; state.stopRequested = false;
  state.httpStatus = null; state.elapsed = null; state.bytes = null; state.responseText = ''; state.data = null; state.headers = null; state.ok = false;
  if (op.mutation) { state.sentKey = request.headers['Idempotency-Key']; lastOperationKey = state.sentKey; }
  if (op.stream) { state.events = []; state.totalEvents = 0; state.lastEventId = null; }
  const timeout = setTimeout(() => controller.abort(), op.stream ? 30000 : 60000);
  refresh(id);
  try {
    const response = await fetch(request.url, { method: request.method, headers, signal: controller.signal, ...(request.body ? { body: JSON.stringify(request.body) } : {}), cache: 'no-store' });
    state.elapsed = performance.now() - started; state.httpStatus = response.status; state.attempted = true;
    state.headers = Object.fromEntries(response.headers); state.ok = response.ok;
    state.label = `HTTP ${response.status}${response.headers.get('idempotency-replayed') === 'true' ? ' · 幂等重放' : response.status === 201 || response.status === 202 ? ' · 已接收' : response.ok ? ' · 成功' : ' · 失败'}`;
    if (op.stream && response.ok) {
      clearTimeout(timeout);
      const reader = response.body.getReader(), decoder = new TextDecoder(), parser = new SseDecoder();
      state.bytes = 0; refresh(id);
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          state.bytes += value.length;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            state.events.push(event); state.totalEvents++;
            if (event.id != null) state.lastEventId = event.id;
            else if (event.type === 'stream.ready' && state.lastEventId == null) state.lastEventId = event.value.data?.cursor;
          }
          state.events = state.events.slice(-100);
          if (id === selectedId) renderResponse();
        }
        state.label = `连接已结束 · ${state.totalEvents} 条事件`;
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      const raw = await response.text(); state.bytes = new TextEncoder().encode(raw).length;
      try { state.data = JSON.parse(raw); state.responseText = JSON.stringify(state.data, null, 2); } catch { state.responseText = raw; }
      state.elapsed = performance.now() - started;
      if (op.id === 'POST /v1/threads' && response.ok && state.data?.threadId) { $('target-thread').value = state.data.threadId; $('target-host').value = state.data.hostId || 'local'; applyTarget(true); toast('新对话已设为测试目标'); }
    }
    state.status = state.ok ? 'ok' : 'error';
  } catch (error) {
    state.attempted = true;
    if (op.stream && state.stopRequested) { state.ok = !!state.httpStatus; state.status = state.ok ? 'ok' : 'idle'; state.label = `已停止订阅 · ${state.totalEvents} 条事件`; }
    else {
      state.ok = false; state.status = 'error'; state.label = error.name === 'AbortError' ? '请求超时 · 未确认' : '连接失败';
      state.responseText = JSON.stringify({ error: error.name === 'AbortError' ? '等待响应超时。' : error.message, ...(op.mutation ? { note: '写操作可能已经被接收。请保留原幂等键，查询操作结果；不要自动换键重试。', operationKey: state.sentKey } : {}) }, null, 2);
    }
  } finally {
    clearTimeout(timeout); state.busy = false; state.controller = null;
    if (state.elapsed == null) state.elapsed = performance.now() - started;
    refresh(id);
  }
  return { ok: state.ok, data: state.data };
}

$('origin').textContent = location.origin;
$('filter').addEventListener('input', renderNav);
$('apply-target').addEventListener('click', () => applyTarget());
$('request-body').addEventListener('input', () => { stateFor(operation(selectedId)).body = $('request-body').value; updatePreview(); });
$('reset-body').addEventListener('click', () => { stateFor(operation(selectedId)).body = JSON.stringify(defaultBody(operation(selectedId), lastTurnId), null, 2); renderForm(); });
$('request-form').addEventListener('submit', event => { event.preventDefault(); run(selectedId); });
$('stop-stream').addEventListener('click', () => { const state = stateFor(operation(selectedId)); state.stopRequested = true; state.controller?.abort(); });
$('clear-events').addEventListener('click', () => { const state = stateFor(operation(selectedId)); state.events = []; renderResponse(); });
$('reuse-cursor').addEventListener('click', () => { const state = stateFor(operation(selectedId)); if (state.lastEventId != null) { state.values.after = String(state.lastEventId); state.values['Last-Event-ID'] = ''; renderForm(); toast('续读游标已填入，下次订阅时使用'); } });
async function connect() {
  if (!operations.length) return;
  $('connect').disabled = true; $('connection-note').className = 'connection-note'; $('connection-note').textContent = '正在核对连接与桌面能力…';
  try {
    const result = await run('GET /v1/capabilities');
    $('connection-status').textContent = result.ok ? 'API 已连接' : '连接失败'; $('connection-status').className = `connection-status ${result.ok ? 'online' : 'failed'}`;
    $('connection-note').textContent = result.ok ? result.data.desktopConnected ? '已直接连接本机 Codex 桌面，可以开始测试全部接口。' : 'API 已连接，Codex 桌面暂未连接；详情见“连接与能力”的响应。' : '连接未通过，请检查服务是否运行。详情见“连接与能力”的响应。';
    if (!result.ok) $('connection-note').classList.add('error');
  } finally { $('connect').disabled = false; }
}
$('connect').addEventListener('click', connect);
$('read-checks').addEventListener('click', async () => {
  $('read-checks').disabled = true;
  const ids = ['GET /healthz', 'GET /v1/capabilities', 'GET /v1/openapi.json', 'GET /v1/projects', 'GET /v1/threads', 'GET /v1/threads/archived'];
  let passed = 0;
  try { for (const id of ids) { const result = await run(id); if (result.ok) passed++; } toast(`基础检查：${passed} / ${ids.length} 个请求成功，可点击各接口查看响应`); }
  finally { $('read-checks').disabled = false; }
});
$('copy-curl').addEventListener('click', async () => {
  try { const op = operation(selectedId), state = stateFor(op); await navigator.clipboard.writeText(curlExample(authorizedRequest(op, state.values, state.body), location.origin)); toast('cURL 已复制'); } catch (error) { toast(`未复制：${error.message}`); }
});
$('copy-response').addEventListener('click', async () => { try { const state = stateFor(operation(selectedId)); await navigator.clipboard.writeText(state.responseText || JSON.stringify(state.events.map(event => event.value), null, 2)); toast('响应已复制'); } catch { toast('复制失败，请直接选择响应文本复制'); } });
window.addEventListener('pagehide', () => { for (const state of states.values()) state.controller?.abort(); });

try {
  const response = await fetch('/console/schema.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`接口清单 HTTP ${response.status}`);
  operations = operationsFromSpec(await response.json());
  if (!operations.length) throw new Error('没有读取到接口定义');
  select(selectedId);
  await connect();
} catch (error) { $('connection-note').textContent = `页面初始化失败：${error.message}。请检查服务后刷新页面。`; $('connection-note').classList.add('error'); $('send').disabled = true; }

function authorizedRequest(op, values, body) {
  const request = buildRequest(op, values, body);
  const token = $('bearer-token').value.trim();
  if (token) request.headers.Authorization = 'Bearer ' + token;
  return request;
}
$('bearer-token').addEventListener('input', () => { if (selectedId) updatePreview(); });
