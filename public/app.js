'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 12a22 22 0 0 0 18 0m-9 0v3"/>',
  knowledge: '<path d="M12 7v15m0-15C8 3 4 3 2 4v15c3-1 6 0 10 3 4-3 7-4 10-3V4c-2-1-6-1-10 3Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.2 2.5L20 12M4 12l.7 3.5A8 8 0 0 0 17.9 18"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  edit: '<path d="m16 3 5 5-13 13H3v-5L16 3Zm-3 3 5 5"/>',
  pin: '<path d="m16 3 5 5-4 2-3 6-2-2-6 6m1-13 3-4 6 6-3 4-6-6Z"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 12 9 5 9-5M3 12l9 5 9-5"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
  link: '<path d="m10 13 4-4m-6 8-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 6a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2" transform="translate(2 0) scale(.9)"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  event: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 14 8-14 8V4Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
const labels = { queued: '等待执行', running: '进行中', waiting: '等待答复', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', active: '活跃', paused: '已暂停', concluded: '已结束', fact: '事实', hypothesis: '假设', opinion: '意见', unverified: '待核查', disputed: '有争议', expired: '已过期', professional: '专业记忆', private: '私人记忆', group: '群聊', dm: '私聊', deep: '深聊' };
const tabs = [{ id: 'chat', title: '消息', icon: 'chat' }, { id: 'members', title: '成员', icon: 'people' }, { id: 'works', title: '工作', icon: 'work' }, { id: 'knowledge', title: '知识', icon: 'knowledge' }, { id: 'routines', title: '定时职责', icon: 'clock' }];
const state = { bots: [], rooms: [], works: [], agentRuns: [], routines: [], knowledge: { nodes: [], edges: [] }, provider: {}, runtime: {} };
const ui = { view: 'chat', roomId: 'room-lobby', botId: null, workId: null, nodeId: null, messages: [], roomJobs: [], memories: [], workDetail: null, graph: null, query: '', knowledgeResults: null, roomQuery: '', workFilter: 'all', mobileRoom: false, reply: null, drafts: {}, outbound: {}, loading: true, refreshing: false, refreshAgain: false, streamConnected: false };
Object.assign(ui, { detailOpen: false, detailTab: 'details', profileBotId: null, avatarEditing: false, avatarDraft: null, avatarTab: 'bot', searchOpen: false, menu: null, avatarSaving: false, sendingRooms: new Set(), draftTargets: {}, navigationSeq: 0, messageCache: new Map() });
Object.assign(ui, { agentRunsOpen: new Set(), agentToolsOpen: new Set(), agentRunDetails: new Map(), agentRunRequests: new Map(), agentRunsCancelling: new Set() });
let refreshTimer;
const avatarSaves = new Map();
let avatarSaveEpoch = 0;
ui.avatarSelectionRevision = 0;
function captureMotion(root) { return window.RelayMotion?.capture(root) || (window.RelayAvatars?.capture?.(root), null); }
function hydrateMotion(root, before) { if (window.RelayMotion) window.RelayMotion.hydrate(root, before || undefined); else window.RelayAvatars?.hydrate?.(root); }
function showModal(modal) { if (window.RelayMotion) window.RelayMotion.openDialog(modal); else { if (!modal.open) modal.showModal(); window.RelayAvatars?.hydrate?.(modal); } }
async function closeModal(modal = $('#modal')) { if (window.RelayMotion) await window.RelayMotion.closeDialog(modal); else modal.close(); }
const renderSignature = html => html.replace(/relay-avatar-clip-\d+/g, 'relay-avatar-clip');


function formatTime(value, date = false) {
  if (!value) return '—';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', date ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}
function formatDay(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(time); }
function botById(id) { return state.bots.find(bot => bot.id === id); }
function roomById(id) { return state.rooms.find(room => room.id === id); }
function nameOf(id) { return id === 'user' ? '你' : (String(id || '').startsWith('executor:') ? '专业执行端' : botById(id)?.name || (id === 'system' ? 'Relay' : id || 'Relay')); }
function statusPill(value) { return `<span class="status ${esc(value)}">${esc(labels[value] || value || '未知')}</span>`; }
function listText(value) { return Array.isArray(value) ? value.join('、') : String(value || ''); }
function emptyState(title, description, button = '', iconName = 'spark') { return `<div class="empty-state">${icon(iconName, 32)}<h3>${esc(title)}</h3><p>${esc(description)}</p>${button}</div>`; }
function pageHeader(eyebrow, title, description, buttons = '') { return `<div class="page-header"><div><button class="text-button" data-action="navigate" data-view="chat">${icon('back', 17)}返回聊天</button><h1>${esc(tabs.find(tab => tab.id === ui.view)?.title || title)}</h1></div><div class="page-tools">${buttons}</div></div>`; }
function toast(message, error = false) {
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; $('#toasts').append(node);
  setTimeout(() => node.remove(), error ? 10000 : 4000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回了无法读取的内容（${response.status}）`); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function showConnection(message = '') { const banner = $('#connection-banner'); banner.hidden = !message; banner.textContent = message; }
function captureChatScroll(messages) {
  if (!messages) return null;
  const top = messages.getBoundingClientRect().top;
  const item = [...messages.querySelectorAll('[data-message-id],[data-agent-run-id]')].find(node => node.getBoundingClientRect().bottom > top);
  return {
    top: messages.scrollTop,
    anchor: item && { attribute: item.hasAttribute('data-message-id') ? 'data-message-id' : 'data-agent-run-id', id: item.dataset.messageId || item.dataset.agentRunId, offset: item.getBoundingClientRect().top - top },
    outputs: [...messages.querySelectorAll('.agent-tool-body[id]')].map(body => ({ id: body.id, positions: [...body.querySelectorAll('pre')].map(pre => ({ top: pre.scrollTop, left: pre.scrollLeft })) })),
  };
}
function restoreChatScroll(messages, saved) {
  if (!messages || !saved) return;
  messages.scrollTop = saved.top;
  if (saved.anchor) {
    const item = [...messages.querySelectorAll(`[${saved.anchor.attribute}]`)].find(node => node.getAttribute(saved.anchor.attribute) === saved.anchor.id);
    if (item) messages.scrollTop += item.getBoundingClientRect().top - messages.getBoundingClientRect().top - saved.anchor.offset;
  }
  for (const output of saved.outputs) {
    const body = document.getElementById(output.id);
    if (body) [...body.querySelectorAll('pre')].forEach((pre, index) => {
      const position = output.positions[index];
      if (position) { pre.scrollTop = position.top; pre.scrollLeft = position.left; }
    });
  }
}
function preserveView() {
  const main = $('#main-content'), messages = $('.messages'), works = $('.works-list'), detail = $('.work-detail');
  const active = document.activeElement;
  return { key: main.dataset.viewKey, fields: $$('input[id]:not([type=file]),textarea[id],select[id]', main).map(field => ({ id: field.id, value: field.value })), panelTop: $('.detail-panel')?.scrollTop, panelSection: $('.detail-panel')?.dataset.section, top: main.scrollTop, chatScroll: captureChatScroll(messages), workTop: works?.scrollTop, detailTop: detail?.scrollTop, focusId: active?.id, start: active?.selectionStart, end: active?.selectionEnd };
}
function render() {
  if (ui.composing && document.activeElement?.id === 'message-input' && document.activeElement.form?.dataset.roomId === ui.roomId) { ui.renderDeferred = true; return; }
  ui.renderDeferred = false;
  const saved = preserveView(); renderTopbar();
  const views = { chat: renderChat, members: renderMembers, works: renderWorks, knowledge: renderKnowledge, routines: renderRoutines };
  const key = `${ui.view}:${ui.view === 'chat' ? ui.roomId : ui.view === 'members' ? ui.botId : ui.view === 'works' ? ui.workId : ''}`;
  const main = $('#main-content'), html = views[ui.view]();
  const signature = renderSignature(html);
  if (ui.lastMainHtml === signature && main.dataset.viewKey === key) { restoreFocus(saved); return; }
  const motion = captureMotion(main);
  main.innerHTML = html; ui.lastMainHtml = signature;
  main.dataset.viewKey = key;
  if (saved.key === key) for (const field of saved.fields) { const target = document.getElementById(field.id); if (target) target.value = field.value; }
  $('#main-content').scrollTop = saved.top;
  const works = $('.works-list'); if (works) works.scrollTop = saved.workTop || 0;
  const detail = $('.work-detail'); if (detail) detail.scrollTop = saved.detailTop || 0;
  resizeComposer($('#message-input'));
  hydrateMotion(main, motion);
  const panel = $('.detail-panel:not([data-motion-ghost])'); if (panel && panel.dataset.section === saved.panelSection) panel.scrollTop = saved.panelTop || 0;
  restoreFocus(saved);
  if (saved.key === key) restoreChatScroll($('.messages'), saved.chatScroll);
}
function restoreFocus(saved) { if (!saved.focusId) return; const target = document.getElementById(saved.focusId); if (target) { target.focus({ preventScroll: true }); if (saved.start != null && target.setSelectionRange && !['number','email','file'].includes(target.type)) target.setSelectionRange(saved.start, saved.end); } }
function resizeComposer(input) { if (!input) return; input.style.height = 'auto'; const height = input.scrollHeight; input.style.height = `${Math.min(150, height)}px`; input.style.overflowY = height > 150 ? 'auto' : 'hidden'; }

function roomNotices(room) {
  const failed = ui.roomJobs.filter(job => ['failed', 'interrupted'].includes(job.status));
  const conclusion = room?.conclusion ? `<details class="conclusion-panel" open><summary>${icon('knowledge', 14)} 深聊结论</summary><div class="message-content">${richText(room.conclusion)}</div>${room.conclusionId ? `<button class="text-button" data-action="open-knowledge" data-id="${esc(room.conclusionId)}">查看知识记录 ${icon('arrow', 12)}</button>` : ''}</details>` : '';
  return `${conclusion}${failed.map(job => `<div class="job-notice"><div><strong>${esc(nameOf(job.botId))} 的${job.lane === 'deep' ? '深聊' : '回复'}${job.status === 'interrupted' ? '已中断' : '未完成'}</strong><p>${esc(job.error || '可根据当前状态重新尝试。')}</p></div><button class="small-button" data-action="retry-job" data-id="${esc(job.id)}">重新尝试</button></div>`).join('')}`;
}
function agentRunVersion(run) { return JSON.stringify([run?.status, run?.toolCount, run?.finishedAt, run?.error]); }
function visibleAgentRuns(roomId = ui.roomId) { return (state.agentRuns || []).filter(run => run.roomId === roomId && (run.status === 'running' || Number(run.toolCount) > 0)); }
async function loadAgentRunDetails(id, force = false) {
  if (ui.agentRunRequests.has(id)) return ui.agentRunRequests.get(id);
  const run = state.agentRuns.find(item => item.id === id), version = agentRunVersion(run), previous = ui.agentRunDetails.get(id);
  if (!force && run?.status !== 'running' && previous?.version === version) return;
  const request = (async () => {
    ui.agentRunDetails.set(id, { ...previous, version, loading: true, error: '' });
    try {
      const detail = await api(`/api/agent-runs/${encodeURIComponent(id)}`);
      ui.agentRunDetails.set(id, { detail, version, loading: false, error: '' });
    } catch (error) { ui.agentRunDetails.set(id, { ...previous, version, loading: false, error: error.message }); }
    finally {
      ui.agentRunRequests.delete(id);
      if (ui.view === 'chat' && ui.agentRunsOpen.has(id) && state.agentRuns.some(item => item.id === id && item.roomId === ui.roomId)) render();
      const latest = state.agentRuns.find(item => item.id === id);
      if (ui.agentRunsOpen.has(id) && latest?.roomId === ui.roomId && agentRunVersion(latest) !== version) void loadAgentRunDetails(id);
    }
  })();
  ui.agentRunRequests.set(id, request);
  return request;
}
function refreshOpenAgentRuns() {
  if (ui.view !== 'chat') return;
  for (const run of visibleAgentRuns()) if (ui.agentRunsOpen.has(run.id)) void loadAgentRunDetails(run.id);
}
function agentToolText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
function renderAgentToolResult(value) {
  const result = value?.details ?? value;
  if (result && typeof result === 'object' && typeof result.stdout === 'string') {
    const { stdout, stderr, ...metadata } = result;
    return `<span class="agent-output-label">结果</span><pre>${esc(agentToolText(metadata))}</pre><span class="agent-output-label">标准输出</span><pre>${esc(stdout || '（空）')}</pre>${stderr ? `<span class="agent-output-label">错误输出</span><pre>${esc(stderr)}</pre>` : ''}`;
  }
  return `<span class="agent-output-label">结果</span><pre>${esc(agentToolText(result))}</pre>`;
}
function renderAgentRun(run) {
  const open = ui.agentRunsOpen.has(run.id), entry = ui.agentRunDetails.get(run.id), detail = entry?.detail, cancelling = ui.agentRunsCancelling.has(run.id);
  const toolNames = { read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件', list_files: '查看目录', search_files: '搜索文件', search_text: '搜索内容', execute_command: '执行命令', run_command: '执行命令', relay_action: '成员协作', search_knowledge: '搜索知识' };
  const tools = Array.isArray(detail?.tools) ? detail.tools : [];
  const content = open ? `<div class="agent-run-body" id="agent-run-${esc(run.id)}">${run.workspace ? `<p class="agent-workspace">工作目录 <code>${esc(run.workspace)}</code></p>` : ''}${entry?.loading ? '<p class="agent-run-note" role="status">正在读取执行记录…</p>' : ''}${entry?.error ? `<div class="agent-run-error">无法读取执行记录：${esc(entry.error)} <button class="text-button" data-action="refresh-agent-run" data-id="${esc(run.id)}">重试</button></div>` : ''}${tools.map(tool => {
    const key = `${run.id}:${tool.id || tool.toolCallId}`, toolOpen = ui.agentToolsOpen.has(key), input = toolOpen ? agentToolText(tool.args) : '', result = toolOpen ? agentToolText(tool.result) : '';
    const hint = tool.args && typeof tool.args === 'object' ? tool.args.path || tool.args.command || tool.args.query || tool.args.pattern || '' : '';
    return `<div class="agent-tool"><button class="agent-tool-heading" data-action="toggle-agent-tool" data-id="${esc(key)}" aria-expanded="${toolOpen}" aria-controls="agent-tool-${esc(key)}"><span class="agent-disclosure" aria-hidden="true">${toolOpen ? '▾' : '▸'}</span><strong>${esc(toolNames[tool.name] || tool.name || '工具')}</strong>${hint ? `<span class="agent-tool-hint" title="${esc(hint)}">${esc(hint)}</span>` : ''}${statusPill(tool.status)}</button>${toolOpen ? `<div class="agent-tool-body" id="agent-tool-${esc(key)}"><div class="agent-tool-meta"><code>${esc(tool.name)}</code><time>${esc(formatTime(tool.startedAt, true))}${tool.finishedAt ? ` → ${esc(formatTime(tool.finishedAt))}` : ''}</time></div><span class="agent-output-label">输入</span><pre>${esc(input || '无参数')}</pre>${result ? renderAgentToolResult(tool.result) : ''}${tool.error ? `<p class="agent-run-error">${esc(agentToolText(tool.error))}</p>` : ''}${!result && !tool.error ? `<p class="agent-run-note">${tool.status === 'running' ? '工具正在执行，尚无结果。' : '没有记录到结果内容。'}</p>` : ''}</div>` : ''}</div>`;
  }).join('')}${!tools.length && !entry?.loading && !entry?.error ? `<p class="agent-run-note">${run.status === 'running' ? '正在处理，尚无工具调用记录。' : '没有工具调用记录。'}</p>` : ''}${run.error ? `<p class="agent-run-error">${esc(agentToolText(run.error))}</p>` : ''}${run.summary ? `<p class="agent-run-summary">${esc(agentToolText(run.summary))}</p>` : ''}${run.finishedAt ? `<time class="agent-run-note">结束于 ${esc(formatTime(run.finishedAt, true))}</time>` : ''}</div>` : '';
  return `<article class="agent-run-card" data-agent-run-id="${esc(run.id)}"><div class="agent-run-header"><button class="agent-run-heading" data-action="toggle-agent-run" data-id="${esc(run.id)}" aria-expanded="${open}" aria-controls="agent-run-${esc(run.id)}"><span class="agent-disclosure" aria-hidden="true">${open ? '▾' : '▸'}</span>${icon('computer', 16)}<span><strong>${esc(nameOf(run.botId))} 的操作</strong><small>${esc(formatTime(run.startedAt))} · ${Number(run.toolCount) || 0} 次工具调用</small></span>${statusPill(run.status)}</button>${run.status === 'running' ? `<button class="agent-run-cancel text-button" data-action="cancel-agent-run" data-id="${esc(run.id)}" ${cancelling ? 'disabled' : ''} aria-label="取消${esc(nameOf(run.botId))}的操作">${cancelling ? '正在取消…' : '取消'}</button>` : ''}</div>${content}</article>`;
}
async function refresh(force = false) {
  if (ui.refreshing) { ui.refreshAgain = true; return; }
  ui.refreshing = true;
  try {
    const avatarReadEpoch = avatarSaveEpoch;
    const next = await api('/api/state');
    Object.assign(state, next); for (const [id, pending] of avatarSaves) { const bot = state.bots?.find(item => item.id === id); if (bot && (pending.running || pending.error || pending.savedVersion !== pending.version || avatarReadEpoch < pending.confirmedEpoch)) bot.avatar = { ...pending.target }; else if (!pending.running && !pending.error) avatarSaves.delete(id); } state.bots ||= []; state.rooms ||= []; state.works ||= []; state.agentRuns ||= []; state.routines ||= []; state.knowledge ||= { nodes: [], edges: [] };
    if (!roomById(ui.roomId)) ui.roomId = state.rooms[0]?.id || null;
    if (!botById(ui.botId)) ui.botId = state.bots[0]?.id || null;
    if (!state.works.some(work => work.id === ui.workId)) ui.workId = state.works[0]?.id || null;
    if (!state.knowledge.nodes?.some(node => node.id === ui.nodeId)) ui.nodeId = state.knowledge.nodes?.[0]?.id || null;
    await loadCurrent();
    ui.loading = false; showConnection(ui.streamConnected ? '' : '实时连接暂未建立，当前显示最近一次读取的状态；正在自动重连。'); render();
  } catch (error) { showConnection(`无法读取最新状态：${error.message}。请检查本地服务后刷新。`); if (ui.loading) $('#main-content').innerHTML = emptyState('暂时无法打开工作空间', error.message, '<button class="primary-button" data-action="refresh">重新连接</button>', 'info'); else if (force) toast(error.message, true); }
  finally { ui.refreshing = false; if (ui.refreshAgain) { ui.refreshAgain = false; scheduleRefresh(); } }
}
async function loadCurrent() {
  if (ui.view === 'chat' && ui.roomId) {
    const id = ui.roomId, response = await api(`/api/rooms/${encodeURIComponent(id)}/messages`);
    const cached = { messages: Array.isArray(response) ? response : response.messages || [], jobs: response.jobs || [] }; ui.messageCache.set(id, cached);
    if (id === ui.roomId) { ui.messagesRoomId = id; ui.messages = cached.messages; ui.roomJobs = cached.jobs; refreshOpenAgentRuns(); }
    const bot = profileBot();
    if (ui.detailOpen && bot) {
      ui.botId = bot.id;
      const memories = await api(`/api/bots/${encodeURIComponent(bot.id)}/memories`);
      if (profileBot()?.id === bot.id) ui.memories = memories.memories || [];
    }
  } else if (ui.view === 'members' && ui.botId) {
    const id = ui.botId, response = await api(`/api/bots/${encodeURIComponent(id)}/memories`); if (id === ui.botId) ui.memories = response.memories || response || [];
  } else if (ui.view === 'works' && ui.workId) {
    const id = ui.workId, response = await api(`/api/works/${encodeURIComponent(id)}`); if (id === ui.workId) ui.workDetail = response.work ? { ...response.work, events: response.events || [] } : response;
  } else if (ui.view === 'knowledge') {
    if (ui.query) ui.knowledgeResults = await api(`/api/knowledge/search?q=${encodeURIComponent(ui.query)}`);
    if (ui.nodeId) ui.graph = await api(`/api/knowledge/graph?id=${encodeURIComponent(ui.nodeId)}&depth=1`);
  }
}
function restoreRoomMessages(id) { const cached = ui.messageCache.get(id); ui.messages = cached?.messages || []; ui.roomJobs = cached?.jobs || []; ui.messagesRoomId = cached ? id : null; }
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 230); }
async function navigate(view) { ui.navigationSeq++; ui.menu = null; ui.view = view; location.hash = view; renderTopbar(); try { await loadCurrent(); render(); } catch (error) { toast(error.message, true); render(); } }

function roomSection(title, kind, rooms) {
  const filtered = rooms.filter(room => room.kind === kind && (!ui.roomQuery || room.name?.toLowerCase().includes(ui.roomQuery.toLowerCase())));
  if (!filtered.length) return '';
  return `<div class="section-label">${title}<span>${filtered.length}</span></div>${filtered.map(room => {
    const members = (room.members || []).filter(id => id !== 'user');
    const description = room.status === 'concluded' ? '已结束 · 结论已保留' : room.goal || (kind === 'dm' ? members.map(nameOf).join('、') : `${members.length} 位成员 · ${kind === 'deep' ? '独立深入讨论' : '随时交流'}`);
    return `<button class="room-row ${room.id === ui.roomId ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}"><span class="room-symbol">${kind === 'group' ? '#' : icon(kind === 'deep' ? 'layers' : 'chat', 17)}</span><span class="room-copy"><strong>${esc(room.name || '未命名会话')}</strong><p>${esc(description)}</p></span>${room.kind === 'deep' && room.status === 'active' ? '<i class="room-kind-dot"></i>' : ''}</button>`;
  }).join('')}`;
}
function renderMembers() {
  const bot = botById(ui.botId); const expertise = Array.isArray(bot?.expertise) ? bot.expertise : String(bot?.expertise || '').split(/[、,，\n]/).filter(Boolean);
  return `<div class="page">${pageHeader('The people behind the work', '各有专长，一起向前。', '长期身份与专业责任，让每次合作都有积累。', `<button class="primary-button" data-action="new-bot">${icon('plus', 15)}新建成员</button>`)}<div class="bot-directory"><div class="directory-list"><div class="directory-list-head"><span>成员目录</span><span>${state.bots.length} 位成员</span></div>${state.bots.map(item => `<button class="bot-row ${item.id === ui.botId ? 'selected' : ''}" data-action="select-bot" data-id="${esc(item.id)}">${avatar(item.id)}<span class="bot-row-copy"><strong>${esc(item.name)}</strong><p>${esc(item.role || '尚未填写职责')}</p></span><span class="presence ${item.status === 'paused' ? 'disabled' : ''}" title="${item.status === 'paused' ? '已暂停' : '活跃'}"></span></button>`).join('')}</div><section class="profile-detail">${bot ? `<div class="profile-top">${avatar(bot.id, true)}<div><h2>${esc(bot.name)}</h2><p>${esc(bot.role || '平级成员')} · ${bot.status === 'paused' ? '已暂停' : '活跃'}</p></div></div><div class="profile-actions"><button class="primary-button" data-action="dm-bot" data-id="${esc(bot.id)}">${icon('chat', 14)}开始私聊</button><button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">${icon('edit', 13)}编辑 Profile</button><button class="icon-button" data-action="toggle-bot" data-id="${esc(bot.id)}" title="${bot.status === 'paused' ? '恢复成员' : '暂停成员'}" aria-label="${bot.status === 'paused' ? '恢复成员' : '暂停成员'}">${icon(bot.status === 'paused' ? 'play' : 'pause', 15)}</button></div><div class="profile-block"><h3>专业领域</h3><div class="tag-list">${expertise.map(text => `<span class="tag">${esc(text)}</span>`).join('') || '<span class="subtle">尚未填写</span>'}</div></div><div class="profile-block"><h3>身份与工作方式</h3><p>${esc(bot.prompt || '尚未填写个性与工作方式。')}</p><div class="item-meta">社交模型：deepseek-flash · 专业执行：${esc(bot.executor || 'codex')}</div>${bot.skills?.length ? `<div class="tag-list" style="margin-top:12px">${bot.skills.map(skill => `<span class="tag">${esc(skill)}</span>`).join('')}</div>` : ''}</div><div class="profile-block"><div class="memory-head"><h3>长期记忆<span class="count-pill">${ui.memories.length}</span></h3><button class="text-button" data-action="new-memory">＋ 添加记忆</button></div>${ui.memories.map(memory => `<article class="memory-item"><p>${esc(memory.content)}</p><div class="item-meta"><span>${esc(labels[memory.category] || memory.category)}</span><span>${memory.status === 'expired' ? '已过期' : '有效'}</span>${memory.source ? `<span>来源：${esc(memory.source)}</span>` : ''}${memory.version ? `<span>版本：${esc(memory.version)}</span>` : ''}<button class="text-button" data-action="edit-memory" data-id="${esc(memory.id)}">修订</button></div></article>`).join('') || '<p class="subtle" style="font-size:12px">还没有长期记忆。新的经验会逐步留在这里。</p>'}</div>` : emptyState('认识你的第一位成员', '为成员设定明确的职责、专长和工作方式。', '', 'people')}</section></div></div>`;
}

function eventText(event) {
  const data = event.data;
  if (typeof data === 'string') return data;
  if (!data) return event.content || event.message || '';
  if (data.item) {
    const item = data.item;
    return [item.text, item.command, item.aggregatedOutput, item.exitCode != null ? `退出码：${item.exitCode}` : ''].filter(Boolean).join('\n') || ({ reasoning: '执行端正在分析目标与上下文。', fileChange: '工作目录文件发生变更。', dynamicToolCall: '执行端正在调用协作工具。' }[item.type] || item.type || '执行状态已更新');
  }
  for (const field of ['text', 'delta', 'message', 'content', 'summary', 'question', 'answer', 'error']) if (typeof data[field] === 'string') return data[field];
  if (event.type === 'thread_started') return `工作会话已建立${data.model ? ` · ${data.model}` : ''}`;
  if (event.type === 'thread_resumed') return '继续已有工作会话。';
  if (event.type === 'turn_completed') return data.error?.message || `本次执行${data.status === 'completed' ? '已完成' : data.status === 'interrupted' ? '已中断' : '已结束'}。`;
  if (event.type === 'queued') return data.goal || '等待执行端接手。';
  return JSON.stringify(data, null, 2);
}
function visibleWorkEvents(events = []) {
  const grouped = [];
  for (const event of events) {
    const last = grouped.at(-1);
    if (['message_delta', 'command_output'].includes(event.type) && last?.type === event.type && last.data?.itemId === event.data?.itemId) last.data.text = (last.data.text || '') + (event.data?.text || '');
    else grouped.push({ ...event, data: typeof event.data === 'object' && event.data ? { ...event.data } : event.data });
  }
  return grouped;
}
function renderWorks() {
  const filters = [{ id: 'all', name: '全部' }, { id: 'active', name: '进行中' }, { id: 'waiting', name: '待答复' }, { id: 'completed', name: '已完成' }, { id: 'attention', name: '待处理' }];
  const works = state.works.filter(work => ui.workFilter === 'all' || (ui.workFilter === 'active' ? ['queued', 'running'].includes(work.status) : ui.workFilter === 'attention' ? ['failed', 'interrupted', 'cancelled'].includes(work.status) : work.status === ui.workFilter));
  const work = ui.workDetail?.id === ui.workId ? ui.workDetail : state.works.find(item => item.id === ui.workId);
  const eventLabels = { thread_started: '工作会话已建立', thread_resumed: '工作会话已恢复', message_delta: '执行端消息', command_output: '命令输出', item_started: '开始处理', item_completed: '处理完成', consult_requested: '中途咨询', consult_answer: '咨询答复', consult_failed: '咨询未完成', interrupt_acknowledged: '执行端已停止', interrupt_error: '停止请求异常', resume_queued: '等待恢复', steered: '补充要求已传递', turn_completed: '本轮执行结束', connection_lost: '执行端连接中断', result_delivery_error: '结果回传异常', created: '工作已建立', queued: '进入队列', started: '开始执行', running: '执行中', status: '状态变化', progress: '执行进度', output: '执行输出', message: '执行消息', consultation: '中途咨询', consult: '中途咨询', question: '等待答复', answer: '咨询答复', completed: '工作完成', failed: '执行失败', error: '执行异常', cancelled: '已取消', resumed: '恢复工作', interrupted: '工作中断', command: '执行命令', reasoning: '正在思考', result: '执行结果' };
  return `<div class="page">${pageHeader('Clear goals. Real progress.', '交出去的事，有迹可循。', '专业执行独立推进，过程、咨询和结果都留在这里。', `<button class="primary-button" data-action="new-work">${icon('plus', 15)}委托工作</button>`)}<div class="filter-bar">${filters.map(filter => `<button class="filter-tab ${ui.workFilter === filter.id ? 'active' : ''}" data-action="work-filter" data-id="${filter.id}">${filter.name}</button>`).join('')}</div><div class="works-layout"><div class="works-list">${works.map(item => `<button class="work-row ${item.id === ui.workId ? 'selected' : ''}" data-action="select-work" data-id="${esc(item.id)}"><div class="work-row-top">${statusPill(item.status)}<time>${formatTime(item.createdAt, true)}</time></div><h3>${esc(item.goal)}</h3><div class="item-meta"><span>${esc(nameOf(item.botId))}</span><span>·</span><span>${esc(roomById(item.roomId)?.name || '独立工作')}</span></div></button>`).join('') || emptyState('这里暂时没有工作', '把目标交给合适的成员，执行端会独立推进。', '', 'work')}</div><section class="work-detail">${work ? `<div class="work-detail-header"><div><div class="eyebrow">WORK / ${esc(work.id.slice(-8))}</div><div class="item-meta">${statusPill(work.status)}</div></div><div class="page-tools">${['queued', 'running', 'waiting'].includes(work.status) ? `<button class="danger-button" data-action="cancel-work" data-id="${esc(work.id)}">取消工作</button>` : ''}${['failed', 'interrupted', 'cancelled'].includes(work.status) ? `<button class="primary-button" data-action="resume-work" data-id="${esc(work.id)}">${icon('play', 12)}恢复工作</button>` : ''}</div></div><h2>${esc(work.goal)}</h2><dl class="work-facts"><dt>委托成员</dt><dd>${esc(nameOf(work.botId))}</dd><dt>来源会话</dt><dd>${esc(roomById(work.roomId)?.name || '独立工作')}</dd><dt>工作目录</dt><dd>${esc(work.cwd || '默认项目目录')}</dd>${work.model ? `<dt>执行模型</dt><dd>${esc(work.model)}</dd>` : ''}<dt>创建时间</dt><dd>${formatTime(work.createdAt, true)}</dd></dl>${work.constraints ? `<div class="work-description"><div class="item-meta" style="margin:0 0 8px">约束与注意事项</div>${esc(listText(work.constraints))}</div>` : ''}${work.inputRefs?.length ? `<div class="work-description"><div class="item-meta" style="margin:0 0 8px">输入资料</div>${esc(listText(work.inputRefs))}</div>` : ''}${work.error ? `<div class="error-state">${esc(work.error)}</div>` : ''}${work.status === 'interrupted' ? '<div class="context-note">上次执行已中断。恢复会继续已有工作对话；已进行的操作不会被视为从未发生。</div>' : ''}${work.question && work.question.status !== 'answered' && ['waiting', 'interrupted'].includes(work.status) ? `<form id="answer-form" class="consultation" data-id="${esc(work.id)}"><h3>${icon('chat', 14)} 执行中需要一点补充</h3><p>${esc(work.question.text || work.question.question || work.question)}</p><textarea id="consult-answer" name="answer" aria-label="咨询答复" placeholder="补充所需信息，执行端就能继续…" required></textarea><button class="primary-button" type="submit">${work.status === 'interrupted' ? '保存答复，供恢复时使用' : '答复并继续'} ${icon('arrow', 13)}</button></form>` : ''}${work.summary ? `<div class="work-description"><div class="eyebrow" style="margin-bottom:10px">执行结果</div>${richText(work.summary)}</div>` : ''}<div class="log-title"><strong>进度记录</strong><span class="subtle">${(work.events || []).length} 条</span></div><div class="timeline">${visibleWorkEvents(work.events).map(event => `<article class="timeline-item ${['error', 'failed'].includes(event.type) ? 'error' : ''}"><div class="timeline-meta"><strong>${esc(eventLabels[event.type] || event.type)}</strong><time>${formatTime(event.createdAt || event.timestamp)}</time></div><div class="timeline-body">${esc(eventText(event))}</div></article>`).join('') || '<p class="subtle" style="font-size:12px">暂无详细进度。</p>'}</div>` : emptyState('选择一项工作', '选择一项工作查看进度，或发起你的第一份委托。', '', 'work')}</section></div></div>`;
}

function renderKnowledge() {
  const nodes = ui.query && ui.knowledgeResults ? ui.knowledgeResults.nodes || [] : state.knowledge.nodes || [];
  const selected = state.knowledge.nodes?.find(node => node.id === ui.nodeId);
  const graph = ui.graph || state.knowledge;
  const edges = (graph.edges || []).filter(edge => edge.from === ui.nodeId || edge.to === ui.nodeId);
  const nodeTitle = id => graph.nodes?.find(node => node.id === id)?.title || state.knowledge.nodes?.find(node => node.id === id)?.title || id;
  return `<div class="page">${pageHeader('A shared understanding', '把共识留下，让经验相连。', '事实、假设和待核查事项分别记录，保留来源与修订。', `<button class="secondary-button" data-action="new-edge">${icon('link', 14)}建立关联</button><button class="primary-button" data-action="new-node">${icon('plus', 15)}新增知识</button>`)}<form id="knowledge-search-form" class="knowledge-toolbar"><input id="knowledge-query" class="search-input" placeholder="搜索知识内容、标题与成员记忆…" value="${esc(ui.query)}" aria-label="搜索知识"><button class="secondary-button" type="submit">${icon('search', 14)}搜索</button>${ui.query ? '<button class="text-button" type="button" data-action="clear-search">清除筛选</button>' : ''}</form><div class="knowledge-layout"><div class="knowledge-list">${nodes.map(node => `<button class="knowledge-node ${node.id === ui.nodeId ? 'selected' : ''}" data-action="select-node" data-id="${esc(node.id)}"><div class="knowledge-meta"><span>${esc(labels[node.type] || node.type || '知识')}</span><span>${node.status === 'active' ? '有效' : esc(labels[node.status] || node.status)}</span></div><h3>${esc(node.title)}</h3><p>${esc(node.content)}</p><div class="item-meta">${node.source ? `<span>来源：${esc(node.source)}</span>` : '<span>尚未注明来源</span>'}${node.version ? `<span>· ${esc(node.version)}</span>` : ''}</div></button>`).join('') || emptyState(ui.query ? '没有找到匹配的知识' : '还没有知识记录', ui.query ? '试试其他关键词，或查看下方匹配的成员记忆。' : '保存有用的事实、讨论结论与专业经验，下一次合作可以从这里继续。', '', 'knowledge')}${ui.query && ui.knowledgeResults?.memories?.length ? `<div class="section-label">相关成员记忆</div>${ui.knowledgeResults.memories.map(memory => `<article class="knowledge-node"><div class="knowledge-meta">${esc(nameOf(memory.botId))} · ${esc(labels[memory.category] || '记忆')}</div><p style="margin-top:10px">${esc(memory.content)}</p></article>`).join('')}` : ''}</div><section class="knowledge-detail">${selected ? `<div class="knowledge-meta"><span>${esc(labels[selected.type] || '知识')} · ${selected.status === 'active' ? '有效' : esc(labels[selected.status] || selected.status)}</span><button class="text-button" data-action="edit-node" data-id="${esc(selected.id)}">${icon('edit', 12)} 修订</button></div><h2>${esc(selected.title)}</h2><div class="knowledge-content">${richText(selected.content)}</div><div class="item-meta">${selected.source ? `来源：${esc(selected.source)}` : '尚未注明来源'}${selected.version ? `<br>适用版本：${esc(selected.version)}` : ''}</div><div class="context-section" style="margin-top:25px"><div class="memory-head"><h4>关联知识</h4><button class="text-button" data-action="new-edge">＋ 关联</button></div>${edges.map(edge => `<div class="relationship"><button class="relation-node" data-action="select-node" data-id="${esc(edge.from)}">${esc(nodeTitle(edge.from))}</button><button class="relation-label" data-action="edit-edge" data-id="${esc(edge.id)}" title="修订关系">${esc(edge.relation)}</button><button class="relation-node" data-action="select-node" data-id="${esc(edge.to)}">${esc(nodeTitle(edge.to))}</button></div>`).join('') || '<p>这条知识尚未建立关联。</p>'}</div>${selected.history?.length ? `<details class="context-section"><summary style="font-size:11px;cursor:pointer">修订历史 · ${selected.history.length} 次</summary>${selected.history.map(entry => `<div class="memory-item"><div class="item-meta">${formatTime(entry.updatedAt || entry.createdAt || entry.at, true)}</div><p>${esc(entry.content || entry.snapshot?.content || JSON.stringify(entry))}</p></div>`).join('')}</details>` : ''}` : emptyState('选择一条知识', '选择一条知识，查看内容、来源、历史与关联。', '', 'link')}</section></div></div>`;
}

function renderRoutines() {
  const enabled = state.routines.filter(routine => routine.enabled).length;
  function interval(seconds) { return seconds % 3600 === 0 ? `每 ${seconds / 3600} 小时` : seconds % 60 === 0 ? `每 ${seconds / 60} 分钟` : `每 ${seconds} 秒`; }
  return `<div class="page">${pageHeader('Make room for the recurring', '该惦记的事，按时想起。', '为成员安排持续职责，也可以随时投递一次新的事件。', `<button class="secondary-button" data-action="new-event">${icon('event', 14)}投递事件</button><button class="primary-button" data-action="new-routine">${icon('plus', 15)}新增职责</button>`)}<div class="routine-summary">${icon('clock', 27)}<div><strong>${enabled} 项职责正在运行</strong><p>到期后投递给指定成员；服务重启后继续保留安排。</p></div></div>${state.routines.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>职责</th><th>负责成员</th><th>执行频率</th><th>下一次</th><th>状态</th><th></th></tr></thead><tbody>${state.routines.map(routine => `<tr><td><strong>${esc(routine.name || '定时职责')}</strong><p>${esc(routine.instruction)}</p>${routine.lastStatus ? `<div class="item-meta">最近：${esc(labels[routine.lastStatus] || routine.lastStatus)}</div>` : ''}</td><td><span class="routine-owner">${avatar(routine.botId)}${esc(nameOf(routine.botId))}</span><p>${esc(roomById(routine.roomId)?.name || '未指定会话')}</p></td><td style="white-space:nowrap">${interval(Number(routine.intervalSeconds) || 60)}</td><td style="white-space:nowrap">${routine.enabled ? formatTime(routine.nextRunAt, true) : '已暂停'}${routine.lastRunAt ? `<p>上次 ${formatTime(routine.lastRunAt, true)}</p>` : ''}</td><td><button class="toggle ${routine.enabled ? 'on' : ''}" data-action="toggle-routine" data-id="${esc(routine.id)}" role="switch" aria-checked="${!!routine.enabled}" aria-label="${routine.enabled ? '暂停' : '开启'}${esc(routine.name)}"></button></td><td><button class="icon-button" data-action="edit-routine" data-id="${esc(routine.id)}" aria-label="编辑职责" title="编辑职责">${icon('edit', 14)}</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('还没有定时职责', '例如每天整理项目待办，或定期回顾最近讨论。你可以随时暂停和修改。', '<button class="secondary-button" data-action="new-routine">创建第一项职责</button>', 'clock')}</div>`;
}

function field(label, name, value = '', options = {}) {
  const { type = 'text', placeholder = '', help = '', required = false, rows, min } = options;
  const control = type === 'textarea' ? `<textarea id="field-${name}" name="${name}" ${required ? 'required' : ''} ${rows ? `rows="${rows}"` : ''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${min != null ? `min="${min}"` : ''} placeholder="${esc(placeholder)}">`;
  return `<div class="form-field"><label for="field-${name}">${label}</label>${control}${help ? `<small>${esc(help)}</small>` : ''}</div>`;
}
function selectField(label, name, options, value, help = '') { return `<div class="form-field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${options.map(option => `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>${help ? `<small>${esc(help)}</small>` : ''}</div>`; }
function botOptions() { return state.bots.map(bot => ({ value: bot.id, label: bot.name })); }
function roomOptions() { return state.rooms.filter(room => room.status !== 'concluded').map(room => ({ value: room.id, label: room.name })); }
function memberChoices(selected = []) { return `<div class="form-field"><label>参与成员</label>${state.bots.map(bot => `<label class="member-choice">${avatar(bot.id)}<span>${esc(bot.name)}<small>${esc(bot.role)}</small></span><input type="checkbox" name="members" value="${esc(bot.id)}" ${selected.includes(bot.id) ? 'checked' : ''}></label>`).join('')}<small>勾选需要参与会话的 Bot。</small></div>`; }
function openModal(title, description, content, save, submitLabel = '保存') {
  const modal = $('#modal');
  captureMotion($('#modal-content'));
  modal.classList.remove('create-bot-modal'); ui.menu = null; renderTopbar();
  $('#modal-content').innerHTML = `<div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 17)}</button></div><form id="modal-form" class="modal-form">${content}<div class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">${esc(submitLabel)}</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target; const button = $('button[type=submit]', form); const error = $('.form-error', form); error.textContent = ''; button.disabled = true;
    try { await save(new FormData(form), form); if (modal.open && $('#modal-form') === form) await closeModal(modal); await refresh(); } catch (cause) { if (form.isConnected) error.textContent = cause.message; else toast(cause.message, true); } finally { button.disabled = false; }
  };
  showModal(modal);
}
function openRoomForm(kind = 'group') {
  const current = roomById(ui.roomId);
  openModal('新建会话', '选好成员和交流方式，留出适合这个话题的空间。', `${selectField('会话方式', 'kind', [{ value: 'group', label: '群聊 · 日常交流' }, { value: 'dm', label: '私聊 · 一对一沟通' }, { value: 'deep', label: '深聊 · 围绕目标深入讨论' }], kind)}${field('会话名称', 'name', '', { required: true, placeholder: kind === 'deep' ? '例如：下一版交互方案' : '给这段对话一个名字' })}${memberChoices(kind === 'deep' ? (current?.members || []).filter(id => id !== 'user') : state.bots.filter(bot => bot.status !== 'paused').map(bot => bot.id))}${field('讨论目标', 'goal', '', { type: 'textarea', placeholder: '这段对话需要解决什么？', help: '深聊需要明确目标，结束后将沉淀结论并回到来源会话。' })}${selectField('来源会话', 'originRoomId', [{ value: '', label: '无来源 · 独立会话' }, ...roomOptions()], kind === 'deep' ? ui.roomId : '')}`, async data => {
    const members = data.getAll('members'); const roomKind = data.get('kind');
    if (!members.length) throw new Error('请至少选择一位成员。');
    if (roomKind === 'dm' && members.length > 2) throw new Error('私聊最多选择两位成员；多人讨论请选择群聊。');
    if (roomKind === 'deep' && !data.get('goal').trim()) throw new Error('请填写深聊目标。');
    const room = await api('/api/rooms', 'POST', { name: data.get('name').trim(), kind: roomKind, members: roomKind === 'dm' && members.length === 2 ? members : ['user', ...members], goal: data.get('goal').trim(), originRoomId: data.get('originRoomId') || null });
    ui.navigationSeq++; ui.roomId = room.id || room.room?.id; ui.view = 'chat'; location.hash = 'chat'; ui.mobileRoom = true; ui.reply = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; toast('会话已创建');
  }, '创建会话');
}
function openBotForm(id) {
  const bot = botById(id);
  openModal(bot ? '编辑成员 Profile' : '认识一位新成员', '明确专业责任与工作方式，让成员拥有持续的身份。', `${field('成员名称', 'name', bot?.name || '', { required: true, placeholder: '例如：架构师' })}${field('主要职责', 'role', bot?.role || '', { required: true, placeholder: '这个成员长期负责什么？' })}${field('专业领域', 'expertise', listText(bot?.expertise), { placeholder: '用逗号分隔，例如：系统设计、代码审查' })}${field('技能说明', 'skills', (bot?.skills || []).join('\n'), { type: 'textarea', placeholder: '每行一项，例如：代码阅读与定位、回归测试设计', help: '作为成员协作时的能力说明，不自动安装外部技能。' })}${field('身份与工作方式', 'prompt', bot?.prompt || '', { type: 'textarea', rows: 5, placeholder: '专业背景、协作偏好、遇到问题时如何处理…' })}<div class="context-note">社交模型统一为 DeepSeek Flash。专业执行交给独立执行端。</div>`, async data => {
    const payload = { name: data.get('name').trim(), role: data.get('role').trim(), expertise: data.get('expertise').trim(), skills: data.get('skills').split('\n').map(text => text.trim()).filter(Boolean), prompt: data.get('prompt').trim() };
    const result = await api(bot ? `/api/bots/${encodeURIComponent(bot.id)}` : '/api/bots', bot ? 'PATCH' : 'POST', payload);
    ui.botId = result.id || bot?.id; toast(bot ? 'Profile 已更新' : '新成员已加入');
  });
}
function openMemoryForm(id) {
  const memory = ui.memories.find(item => item.id === id);
  openModal(memory ? '修订长期记忆' : '添加长期记忆', `记录在 ${nameOf(ui.botId)} 的个人记忆中。`, `${field('记忆内容', 'content', memory?.content || '', { type: 'textarea', required: true, rows: 4 })}<div class="form-row">${selectField('记忆类别', 'category', [{ value: 'professional', label: '专业记忆' }, { value: 'private', label: '私人记忆' }], memory?.category || 'professional')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'expired', label: '已过期' }], memory?.status || 'active')}</div>${field('来源', 'source', memory?.source || '', { placeholder: '例如：项目讨论、用户补充' })}${field('适用版本', 'version', memory?.version || '', { placeholder: '选填' })}`, async data => {
    await api(memory ? `/api/memories/${encodeURIComponent(memory.id)}` : `/api/bots/${encodeURIComponent(ui.botId)}/memories`, memory ? 'PATCH' : 'POST', Object.fromEntries(data)); toast('记忆已保存');
  });
}
function openWorkForm() {
  openModal('委托一项工作', '明确目标与边界，成员会将专业执行交给 Codex。', `${field('工作目标', 'goal', '', { type: 'textarea', required: true, placeholder: '希望完成什么？请描述可以观察的结果。', rows: 4 })}<div class="form-row">${selectField('委托成员', 'botId', botOptions(), ui.view === 'members' ? ui.botId : profileBot()?.id || state.bots[0]?.id)}${selectField('结果回到', 'roomId', roomOptions(), ui.roomId)}</div>${field('工作目录', 'cwd', state.defaultCwd || '', { required: true, placeholder: '项目的绝对路径' })}${field('约束与注意事项', 'constraints', '', { type: 'textarea', placeholder: '已有修改、操作边界、需要保留的行为…' })}${field('输入资料', 'inputRefs', '', { type: 'textarea', placeholder: '每行一项：文件路径、资料说明或链接', help: '提供已有资料的位置，方便执行端理解上下文。' })}`, async data => {
    const work = await api('/api/works', 'POST', { ...Object.fromEntries(data), inputRefs: data.get('inputRefs').split('\n').map(text => text.trim()).filter(Boolean) }); ui.workId = work.id || work.work?.id; ui.view = 'works'; toast('工作已交给执行端');
  }, '开始工作');
}
function openNodeForm(id, message) {
  const node = state.knowledge.nodes?.find(item => item.id === id);
  openModal(node ? '修订知识' : '留下一条知识', '明确哪些已知、哪些待核查，并保留信息来源。', `${field('标题', 'title', node?.title || (message ? message.content.slice(0, 35) : ''), { required: true })}${field('内容', 'content', node?.content || message?.content || '', { type: 'textarea', required: true, rows: 5 })}<div class="form-row">${selectField('性质', 'type', ['fact', 'hypothesis', 'opinion', 'unverified'].map(value => ({ value, label: labels[value] })), node?.type || 'unverified')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'disputed', label: '有争议' }, { value: 'expired', label: '已过期' }], node?.status || 'active')}</div>${field('来源', 'source', node?.source || (message ? `会话 ${roomById(message.roomId)?.name || message.roomId} / 消息 ${message.id}` : ''), { placeholder: '文档、讨论或观察记录' })}${field('适用版本', 'version', node?.version || '', { placeholder: '选填，例如 v0.1' })}`, async data => {
    const result = await api(node ? `/api/knowledge/nodes/${encodeURIComponent(node.id)}` : '/api/knowledge/nodes', node ? 'PATCH' : 'POST', Object.fromEntries(data)); ui.nodeId = result.id || node?.id; toast('知识已保存');
  });
}
function openEdgeForm() {
  const nodes = state.knowledge.nodes || []; if (nodes.length < 2) { toast('至少需要两条知识才能建立关联。'); return; }
  const options = nodes.map(node => ({ value: node.id, label: node.title }));
  openModal('建立知识关联', '关系有方向，例如：方案依赖条件，结论来自观察。', `${selectField('起点', 'from', options, ui.nodeId || nodes[0].id)}${field('关系', 'relation', '', { required: true, placeholder: '例如：依赖、支持、来自、修订' })}${selectField('终点', 'to', options, nodes.find(node => node.id !== ui.nodeId)?.id)}${field('来源', 'source', '', { placeholder: '选填：关联的依据' })}`, async data => { if (data.get('from') === data.get('to')) throw new Error('请选择两条不同的知识。'); await api('/api/knowledge/edges', 'POST', Object.fromEntries(data)); toast('关联已建立'); });
}
function openEdgeEdit(id) {
  const edge = (state.knowledge.edges || []).find(item => item.id === id) || ui.graph?.edges?.find(item => item.id === id); if (!edge) return;
  openModal('修订知识关系', '', `${field('关系', 'relation', edge.relation, { required: true })}${field('来源', 'source', edge.source || '')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'expired', label: '已过期' }], edge.status || 'active')}`, async data => { await api(`/api/knowledge/edges/${encodeURIComponent(id)}`, 'PATCH', Object.fromEntries(data)); toast('知识关系已更新'); });
}
function openRoutineForm(id) {
  const routine = state.routines.find(item => item.id === id);
  openModal(routine ? '修改定时职责' : '安排定时职责', '成员会按周期接收职责，在指定会话里回应。', `${field('职责名称', 'name', routine?.name || '', { required: true, placeholder: '例如：项目进度回顾' })}${field('具体职责', 'instruction', routine?.instruction || '', { type: 'textarea', required: true, placeholder: '到期时，成员需要关注或完成什么？' })}<div class="form-row">${selectField('负责成员', 'botId', botOptions(), routine?.botId || profileBot()?.id || state.bots[0]?.id)}${selectField('投递到会话', 'roomId', roomOptions(), routine?.roomId || ui.roomId)}</div>${field('间隔（分钟）', 'intervalMinutes', (routine?.intervalSeconds || 3600) / 60, { type: 'number', min: 1, required: true, help: '最短 1 分钟。重启后只补一次到期职责。' })}<label class="checkbox-line"><input type="checkbox" name="enabled" ${routine?.enabled !== false ? 'checked' : ''}>立即启用</label>`, async data => {
    await api(routine ? `/api/routines/${encodeURIComponent(routine.id)}` : '/api/routines', routine ? 'PATCH' : 'POST', { name: data.get('name'), instruction: data.get('instruction'), botId: data.get('botId'), roomId: data.get('roomId'), intervalSeconds: Number(data.get('intervalMinutes')) * 60, enabled: data.has('enabled') }); toast('职责已保存');
  });
}
function openEventForm() {
  openModal('投递一次事件', '把新的进展或待办交给合适的成员。', `${field('事件类型', 'type', '人工提醒', { required: true, placeholder: '例如：项目更新、人工提醒' })}${field('事件内容', 'content', '', { type: 'textarea', required: true, rows: 4 })}<div class="form-row">${selectField('接收成员', 'botId', botOptions(), state.bots[0]?.id)}${selectField('来源会话', 'roomId', roomOptions(), ui.roomId)}</div>`, async data => { await api('/api/events', 'POST', Object.fromEntries(data)); toast('事件已投递'); }, '投递事件');
}

async function act(action, element) {
  const id = element?.dataset.id;
  if (action === 'toggle-agent-run') { if (ui.agentRunsOpen.has(id)) { ui.agentRunsOpen.delete(id); return render(); } ui.agentRunsOpen.add(id); const request = loadAgentRunDetails(id, true); render(); return request; }
  if (action === 'refresh-agent-run') { const request = loadAgentRunDetails(id, true); render(); return request; }
  if (action === 'toggle-agent-tool') { if (ui.agentToolsOpen.has(id)) ui.agentToolsOpen.delete(id); else ui.agentToolsOpen.add(id); return render(); }
  if (action === 'cancel-agent-run') {
    if (ui.agentRunsCancelling.has(id)) return;
    ui.agentRunsCancelling.add(id); render();
    try { await api(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, 'POST', {}); toast('取消请求已提交'); await refresh(); }
    finally { ui.agentRunsCancelling.delete(id); render(); }
    return;
  }
  if (action === 'toggle-search') { ui.searchOpen = !ui.searchOpen; if (!ui.searchOpen) ui.roomQuery = ''; render(); $('#room-search')?.focus(); return; }
  if (['toggle-create', 'toggle-apps', 'toggle-composer'].includes(action)) { const menu = action.slice(7); ui.menu = ui.menu === menu ? null : menu; return render(); }
  if (action === 'toggle-details') { ui.detailOpen = !ui.detailOpen; ui.profileBotId = null; ui.avatarEditing = false; ui.detailTab = 'details'; render(); await loadCurrent(); return render(); }
  if (action === 'close-details') { ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; return render(); }
  if (action === 'detail-tab') { ui.detailTab = element.dataset.tab; ui.avatarEditing = false; render(); await loadCurrent(); return render(); }
  if (action === 'open-bot-details') { if (!botById(id)) return; ui.profileBotId = id; ui.botId = id; ui.detailOpen = true; ui.avatarEditing = false; ui.detailTab = 'details'; ui.memories = []; render(); await loadCurrent(); return render(); }
  if (action === 'edit-avatar') { ui.avatarSelectionRevision++; const bot = profileBot(); if (!bot) return; ui.avatarEditing = !ui.avatarEditing; ui.avatarDraft = { ...botAvatar(bot) }; ui.avatarTab = 'bot'; return render(); }
  if (action === 'avatar-tab') { ui.avatarTab = element.dataset.tab; return render(); }
  if (action === 'avatar-save-retry') return persistAvatar();
  if (['avatar-shape', 'avatar-color', 'avatar-random', 'avatar-reset'].includes(action)) {
    ui.avatarSelectionRevision++;
    if (action === 'avatar-shape') ui.avatarDraft = { ...ui.avatarDraft, shape: element.dataset.shape, image: null };
    if (action === 'avatar-color') ui.avatarDraft = { ...ui.avatarDraft, color: element.dataset.color, image: null };
    if (action === 'avatar-random') { const shapes = window.RelayAvatars.shapes, colors = window.RelayAvatars.colors; ui.avatarDraft = { shape: shapes[Math.floor(Math.random() * shapes.length)].id, color: colors[Math.floor(Math.random() * colors.length)], image: null }; }
    if (action === 'avatar-reset') ui.avatarDraft = { ...window.RelayAvatars.defaults(profileBot()?.id, state.bots.findIndex(bot => bot.id === profileBot()?.id)), image: null };
    return updateAvatarPicker(element.dataset.mode || 'edit');
  }
  if (action === 'copy-conversation') { await navigator.clipboard.writeText(ui.messages.map(message => `${nameOf(message.senderId)} · ${formatTime(message.createdAt, true)}\n${message.content}`).join('\n\n')); return toast('会话文字已复制'); }
  if (action === 'show-owner') return toast('你是这个本地工作空间的主人。');
  if (action === 'edit-room' || action === 'edit-room-members') return openRoomEdit(action === 'edit-room-members');
  if (action === 'navigate') return navigate(element.dataset.view);
  if (action === 'refresh') return refresh(true);
  if (action === 'close-modal') return closeModal();
  if (action === 'new-room') return openRoomForm();
  if (action === 'new-deep') return openRoomForm('deep');
  if (action === 'select-room') { const navigationSeq = ++ui.navigationSeq; ui.roomId = id; ui.view = 'chat'; location.hash = 'chat'; restoreRoomMessages(ui.roomId); ui.reply = null; ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; ui.mobileRoom = true; render(); await loadCurrent(); if (navigationSeq !== ui.navigationSeq) return; render(); const messages = $('.messages'); if (messages) messages.scrollTop = messages.scrollHeight; return; }
  if (action === 'room-back') { ui.mobileRoom = false; return render(); }
  if (action === 'reply-message') { ui.reply = ui.messages.find(message => message.id === id); render(); $('#message-input')?.focus(); return; }
  if (action === 'cancel-reply') { ui.reply = null; return render(); }
  if (action === 'save-message') return openNodeForm(null, ui.messages.find(message => message.id === id));
  if (action === 'conclude-room') { element.disabled = true; try { await api(`/api/rooms/${encodeURIComponent(ui.roomId)}/conclude`, 'POST', {}); toast('深聊结束请求已提交，结论将保留在会话中。'); await refresh(); } finally { element.disabled = false; } return; }
  if (action === 'new-bot') return openCreateBot();
  if (action === 'edit-bot') return openBotForm(id);
  if (action === 'select-bot' || action === 'open-profile') { ui.botId = id; ui.memories = []; return navigate('members'); }
  if (action === 'toggle-bot') { const bot = botById(id); await api(`/api/bots/${encodeURIComponent(id)}`, 'PATCH', { status: bot.status === 'paused' ? 'active' : 'paused' }); toast(bot.status === 'paused' ? '成员已恢复' : '成员已暂停'); return refresh(); }
  if (action === 'dm-bot') {
    if (!botById(id)) return;
    const navigationSeq = ++ui.navigationSeq;
    const existing = state.rooms.find(room => room.kind === 'dm' && room.status !== 'concluded' && room.members?.includes(id) && room.members.filter(member => member !== 'user').length === 1);
    const room = existing || await api('/api/rooms', 'POST', { name: `与 ${nameOf(id)} 的私聊`, kind: 'dm', members: ['user', id] });
    if (!existing) state.rooms.push(room);
    if (navigationSeq !== ui.navigationSeq) return;
    ui.roomId = room.id; ui.botId = id; restoreRoomMessages(ui.roomId); ui.reply = null; ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; ui.mobileRoom = true; ui.view = 'chat'; location.hash = 'chat'; render(); await refresh(); return;
  }
  if (action === 'new-memory') return openMemoryForm();
  if (action === 'edit-memory') return openMemoryForm(id);
  if (action === 'new-work') return openWorkForm();
  if (action === 'select-work' || action === 'open-work') { ui.workId = id; ui.workDetail = null; return navigate('works'); }
  if (action === 'work-filter') { ui.workFilter = id; return render(); }
  if (action === 'cancel-work' || action === 'resume-work') { element.disabled = true; try { await api(`/api/works/${encodeURIComponent(id)}/${action === 'cancel-work' ? 'cancel' : 'resume'}`, 'POST', {}); toast(action === 'cancel-work' ? '取消请求已提交' : '恢复请求已提交'); await refresh(); } finally { element.disabled = false; } return; }
  if (action === 'new-node') return openNodeForm();
  if (action === 'edit-node') return openNodeForm(id);
  if (action === 'new-edge') return openEdgeForm();
  if (action === 'edit-edge') return openEdgeEdit(id);
  if (action === 'select-node') { ui.nodeId = id; ui.graph = null; await loadCurrent(); return render(); }
  if (action === 'open-knowledge') { ui.nodeId = id; return navigate('knowledge'); }
  if (action === 'retry-job') { element.disabled = true; try { await api(`/api/jobs/${encodeURIComponent(id)}/retry`, 'POST', {}); toast('已重新安排处理'); await refresh(); } finally { element.disabled = false; } return; }
  if (action === 'clear-search') { ui.query = ''; if ($('#knowledge-query')) $('#knowledge-query').value = ''; ui.knowledgeResults = null; return render(); }
  if (action === 'new-routine') return openRoutineForm();
  if (action === 'edit-routine') return openRoutineForm(id);
  if (action === 'toggle-routine') { const routine = state.routines.find(item => item.id === id); await api(`/api/routines/${encodeURIComponent(id)}`, 'PATCH', { enabled: !routine.enabled }); toast(routine.enabled ? '职责已暂停' : '职责已启用'); return refresh(); }
  if (action === 'new-event') return openEventForm();
}

document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button && !button.disabled) act(button.dataset.action, button).catch(error => toast(error.message, true)); });
document.addEventListener('input', event => {
  if (event.target.id === 'create-bot-name') $('#create-bot-submit').disabled = !event.target.value.trim();
  if (event.target.id === 'message-input') { ui.drafts[event.target.form.dataset.roomId] = event.target.value; resizeComposer(event.target); }
  if (event.target.id === 'room-search') { ui.roomQuery = event.target.value; render(); }
});
document.addEventListener('keydown', event => { if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); const button = $('#message-form button[type=submit]'); if (!button?.disabled) $('#message-form')?.requestSubmit(); } });
document.addEventListener('compositionstart', event => { if (event.target.id === 'message-input') ui.composing = true; });
document.addEventListener('compositionend', event => { if (event.target.id !== 'message-input') return; ui.composing = false; ui.drafts[event.target.form.dataset.roomId] = event.target.value; if (ui.renderDeferred) render(); });
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'modal-form') return;
  if (!['message-form', 'answer-form', 'knowledge-search-form'].includes(form.id)) return;
  event.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
  let submittedRoom = null;
  try {
    if (form.id === 'message-form') {
      const raw = $('#message-input', form).value, content = raw.trim(); if (!content) return;
      const roomId = form.dataset.roomId;
      if (ui.sendingRooms.has(roomId)) return;
      ui.sendingRooms.add(roomId); submittedRoom = roomId;
      const payload = { content, toBotId: $('#message-target').value || null, replyTo: ui.reply?.id || null };
      const signature = JSON.stringify(payload);
      if (ui.outbound[roomId]?.signature !== signature) ui.outbound[roomId] = { signature, id: globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, 'POST', { ...payload, clientId: ui.outbound[roomId].id });
      const unchanged = ui.drafts[roomId] === raw;
      if (unchanged) ui.drafts[roomId] = '';
      delete ui.outbound[roomId];
      if (ui.roomId === roomId) { if (ui.reply?.id === payload.replyTo) ui.reply = null; if (unchanged && $('#message-input')?.value === raw) $('#message-input').value = ''; }
      await refresh(); const messages = $('.messages'); if (messages && ui.roomId === roomId) messages.scrollTop = messages.scrollHeight;
    } else if (form.id === 'answer-form') { await api(`/api/works/${encodeURIComponent(form.dataset.id)}/answer`, 'POST', { answer: new FormData(form).get('answer') }); toast('答复已记录'); await refresh(); }
    else { ui.query = $('#knowledge-query').value.trim(); await loadCurrent(); render(); }
  } catch (error) { toast(error.message, true); } finally { if (submittedRoom) ui.sendingRooms.delete(submittedRoom); button.disabled = false; const currentSend = $('#message-form button[type=submit]'); if (currentSend) currentSend.disabled = ui.sendingRooms.has(ui.roomId); }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const box = $('#modal').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeModal(); } });
$('#modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (tabs.some(tab => tab.id === view) && ui.view !== view) navigate(view); });
// Conversation-first layout, matched to the supplied reference screens.
Object.assign(icons, {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
});

function botAvatar(botOrId) {
  const bot = typeof botOrId === 'string' ? botById(botOrId) : botOrId;
  const index = Math.max(0, state.bots.findIndex(item => item.id === bot?.id));
  return { ...(window.RelayAvatars?.defaults(bot?.id || '', index) || { shape: 'circle', color: '#F93498', image: null }), ...(bot?.avatar || {}) };
}
function face(config, size = 60, options = {}) { return window.RelayAvatars ? window.RelayAvatars.render(config, size, options) : `<span class="face-fallback" style="width:${size}px;height:${size}px;background:${esc(config?.color || '#959595')}"></span>`; }
function avatar(id, large = false, key = `bot:${id}`) {
  const size = typeof large === 'number' ? large : large ? 104 : 60;
  if (id === 'user') return `<span class="user-avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${icon('person', Math.round(size * .48))}</span>`;
  if (!botById(id)) return `<span class="system-avatar" style="width:${size}px;height:${size}px">${icon(String(id).startsWith('executor:') ? 'computer' : 'event', Math.round(size * .5))}</span>`;
  return `<span class="bot-avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${face(botAvatar(id), size, { key, identity: `bot:${id}` })}</span>`;
}
function groupAvatar(room, size = 96, key = `group:${room?.id}:${size}`) {
  const members = (room?.members || []).filter(id => id === 'user' || botById(id)).slice(0, 4);
  return `<span class="group-avatar" style="width:${size}px;height:${size}px">${members.map((id, index) => `<span class="group-face pos-${index}">${avatar(id, Math.round(size * .57), `${key}:${index}`)}</span>`).join('')}</span>`;
}
function currentBot() {
  const room = roomById(ui.roomId);
  return room?.kind === 'dm' && room.members?.includes('user') ? botById(room.members.find(id => id !== 'user')) : null;
}
function profileBot() { return ui.profileBotId ? botById(ui.profileBotId) : currentBot(); }
function currentAccent() { return currentBot() ? botAvatar(currentBot()).color : '#222222'; }
function providerLabel() {
  const provider = state.provider || {};
  if (provider.testDouble || /test.?double|regression double/i.test(provider.model || '')) return '界面验证替身';
  return provider.lastError ? '连接异常' : provider.connected ? '已连接' : provider.configured ? '已配置 · 待调用' : '未配置';
}
function renderTopbar() {
  const oldContactTop = $('.contacts-scroll')?.scrollTop || 0, oldPeerOpen = $('.peer-conversations')?.open;
  const query = (ui.roomQuery || '').trim().toLowerCase();
  const groups = state.rooms.filter(room => room.kind !== 'dm' && (!query || `${room.name} ${room.goal}`.toLowerCase().includes(query)));
  const bots = state.bots.filter(bot => !query || `${bot.name} ${bot.role} ${bot.expertise}`.toLowerCase().includes(query));
  const peerRooms = state.rooms.filter(room => room.kind === 'dm' && !room.members?.includes('user') && (!query || room.name.toLowerCase().includes(query)));
  const selectedBot = currentBot();
  const activeWorks = state.works.filter(work => ['queued', 'running', 'waiting'].includes(work.status)).length;
  const menu = ui.menu === 'create' ? `<div class="context-menu create-menu"><button data-action="new-bot">${icon('person', 19)}创建新 Bot</button><button data-action="new-room">${icon('people', 19)}创建群聊</button><button data-action="new-deep">${icon('layers', 19)}创建深聊</button></div>` : '';
  const appMenu = ui.menu === 'apps' ? `<div class="context-menu apps-menu"><div class="menu-title">连接应用</div><div class="connection-row"><span class="app-emblem flash">D</span><div><strong>DeepSeek Flash</strong><small class="${state.provider.lastError ? 'error-text' : ''}">${esc(providerLabel())}</small></div><button class="icon-button" data-action="refresh" title="刷新状态" aria-label="刷新状态">${icon('refresh', 17)}</button></div>${state.provider.lastError ? `<p class="menu-error">${esc(state.provider.lastError)}</p>` : ''}<div class="connection-row"><span class="app-emblem codex">${icon('computer', 21)}</span><div><strong>Codex</strong><small>${activeWorks ? `${activeWorks} 项工作进行中` : '专业执行端'}</small></div></div><div class="menu-separator"></div>${tabs.filter(tab => tab.id !== 'chat').map(tab => `<button data-action="navigate" data-view="${tab.id}">${icon(tab.icon, 19)}${tab.id === 'members' ? '管理 Bot' : tab.title}${tab.id === 'works' && activeWorks ? `<span class="menu-count">${activeWorks}</span>` : ''}</button>`).join('')}<button data-action="new-event">${icon('event', 19)}投递事件</button></div>` : '';
  const sidebar = $('#contact-sidebar');
  const html = `<div class="sidebar-toolbar"><div class="search-slot ${ui.searchOpen ? 'open' : ''}">${ui.searchOpen ? `<input id="room-search" value="${esc(ui.roomQuery)}" placeholder="搜索" aria-label="搜索会话与 Bot">` : ''}<button class="round-button" data-action="toggle-search" title="搜索" aria-label="搜索">${icon('search', 24)}</button></div><div class="menu-anchor"><button class="round-button" data-action="toggle-create" aria-label="新建" title="新建" aria-expanded="${ui.menu === 'create'}">${icon('plus', 27)}</button>${menu}</div></div><div class="contacts-scroll"><div class="group-grid">${groups.map(room => `<button class="group-tile ${room.id === ui.roomId && ui.view === 'chat' ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}" title="${esc(room.name)}">${groupAvatar(room)}<span>${esc(room.name)}</span>${room.kind === 'deep' ? `<small>${room.status === 'concluded' ? '已结束' : '深聊'}</small>` : ''}</button>`).join('')}</div><div class="bot-contacts">${bots.map(bot => {
    const dm = state.rooms.find(room => room.kind === 'dm' && room.members?.includes('user') && room.members?.includes(bot.id));
    const preview = dm?.lastMessage?.content || bot.role || '开始聊天';
    const busy = (state.runtime.jobs || []).some(job => job.botId === bot.id && ['running', 'queued'].includes(job.status));
    return `<button class="contact-row ${ui.view === 'chat' && selectedBot?.id === bot.id && !ui.profileBotId ? 'selected' : ''}" data-action="dm-bot" data-id="${esc(bot.id)}">${avatar(bot.id, 60, `sidebar:${bot.id}`)}<span class="contact-copy"><strong>${esc(bot.name)}</strong><span>${esc(bot.status === 'paused' ? '已暂停' : busy ? '正在处理…' : preview)}</span></span>${busy ? '<i class="activity-dot" title="正在处理"></i>' : ''}</button>`;
  }).join('')}</div>${peerRooms.length ? `<details class="peer-conversations" ${query ? 'open' : ''}><summary>Bot 之间的对话 <span>${peerRooms.length}</span>${icon('chevron', 14)}</summary>${peerRooms.map(room => `<button class="peer-room ${room.id === ui.roomId ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}">${groupAvatar(room, 44)}<span>${esc(room.name)}</span></button>`).join('')}</details>` : ''}${!bots.length && !groups.length ? '<div class="sidebar-empty">没有找到匹配项</div>' : ''}</div><div class="sidebar-footer"><button class="my-avatar-button" data-action="show-owner" title="工作空间主人" aria-label="工作空间主人">${avatar('user', 54)}</button><div class="menu-anchor apps-anchor"><button class="connect-apps" data-action="toggle-apps" aria-expanded="${ui.menu === 'apps'}">连接应用<span class="mini-app-icon flash">D</span><span class="mini-app-icon">${icon('computer', 15)}</span></button>${appMenu}</div></div>`;
  const signature = renderSignature(html);
  if (ui.lastSidebarHtml !== signature) { const motion = captureMotion(sidebar); sidebar.innerHTML = html; ui.lastSidebarHtml = signature; hydrateMotion(sidebar, motion); }
  if ($('.contacts-scroll')) $('.contacts-scroll').scrollTop = oldContactTop;
  if ($('.peer-conversations') && oldPeerOpen !== undefined) $('.peer-conversations').open = oldPeerOpen;
  $('.app-shell').classList.toggle('mobile-room', ui.view === 'chat' && ui.mobileRoom);
  $('.app-shell').classList.toggle('management-open', ui.view !== 'chat');
}
function richText(value) {
  return String(value || '').split(/```(?:[\w-]+)?\n?([\s\S]*?)```/g).map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.trim())}</code></pre>`;
    return esc(part).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/^[-*] (.+)$/gm, '<span class="markdown-li">$1</span>');
  }).join('');
}
function messageActivity(message, room) {
  if (message._activity === 'sent') return `<div class="chat-activity">已发消息给 ${avatar(message.toBotId, 27, `activity:sent:${message.id}`)}<button data-action="dm-bot" data-id="${esc(message.toBotId)}">${esc(nameOf(message.toBotId))}</button></div>`;
  if (message.peerReplyId) {
    const peer = (state.activity || []).find(item => item.id === message.peerReplyId);
    return `<div class="chat-activity">${peer ? `消息来自 ${avatar(peer.senderId, 27, `activity:received:${message.id}`)}<button data-action="dm-bot" data-id="${esc(peer.senderId)}">${esc(nameOf(peer.senderId))}</button>` : '同事回复已回到本会话'}</div>`;
  }
  return '';
}
function renderChat() {
  const room = roomById(ui.roomId), bot = currentBot(), isGroup = room?.kind !== 'dm' || !room?.members?.includes('user');
  const members = (room?.members || []).filter(id => id !== 'user').map(botById).filter(Boolean);
  const jobs = ui.roomJobs.filter(job => ['queued', 'running'].includes(job.status));
  const title = bot?.name || room?.name || 'Relay Bot';
  const accent = currentAccent();
  const activities = (state.activity || []).filter(message => message.returnTo?.roomId === ui.roomId && message.roomId !== ui.roomId && message.toBotId).map(message => ({ ...message, _activity: 'sent' }));
  const runs = visibleAgentRuns().map(run => ({ ...run, _agentRun: true, createdAt: run.startedAt }));
  const timeline = [...ui.messages, ...activities, ...runs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  let previousDay = '';
  const messages = timeline.map(message => {
    if (message._activity) return messageActivity(message, room);
    if (message._agentRun) { const date = formatDay(message.createdAt), divider = date !== previousDay ? `<div class="date-divider">${esc(date)}</div>` : ''; previousDay = date; return `${divider}${renderAgentRun(message)}`; }
    const sender = message.senderId || 'system', own = sender === 'user', system = sender === 'system' || message.kind === 'event';
    const senderBot = botById(sender);
    const date = formatDay(message.createdAt), divider = date !== previousDay ? `<div class="date-divider">${esc(date)}</div>` : ''; previousDay = date;
    if (system && message.kind !== 'error') return `${divider}<div class="chat-activity system-event">${icon(message.kind === 'work' ? 'work' : 'event', 17)}<span>${esc(message.content)}</span></div>`;
    const reply = message.replyTo ? ui.messages.find(item => item.id === message.replyTo) : null;
    return `${divider}${messageActivity(message, room)}<article data-message-id="${esc(message.id)}" data-motion-key="message:${esc(message.id)}" class="chat-message ${own ? 'outgoing' : 'incoming'} ${isGroup ? 'in-group' : ''} ${message.kind === 'error' ? 'error' : ''}">${isGroup && !own ? `<button class="message-avatar-button" data-action="open-bot-details" data-id="${esc(sender)}" title="${esc(nameOf(sender))}">${avatar(sender, 38, `message:${message.id}`)}</button>` : ''}<div class="bubble-column">${isGroup && !own ? `<button class="speaker-name" style="color:${esc(senderBot ? botAvatar(senderBot).color : '#777777')}" data-action="open-bot-details" data-id="${esc(sender)}">${esc(nameOf(sender))}</button>` : ''}<div class="message-bubble" title="${esc(formatTime(message.createdAt, true))}">${message.toBotId ? `<div class="bubble-target">致 ${esc(nameOf(message.toBotId))}</div>` : ''}${reply && own ? `<div class="bubble-reply">${esc(nameOf(reply.senderId))}：${esc(reply.content?.slice(0, 100))}</div>` : ''}<div class="message-content">${richText(message.content)}</div></div><div class="bubble-actions"><span>${formatTime(message.createdAt)}</span><button data-action="reply-message" data-id="${esc(message.id)}" title="回复" aria-label="回复">${icon('back', 17)}</button><button data-action="save-message" data-id="${esc(message.id)}" title="保存为知识" aria-label="保存为知识">${icon('knowledge', 17)}</button></div></div></article>`;
  }).join('');
  const extraMenu = ui.menu === 'composer' ? `<div class="context-menu composer-menu"><button data-action="new-work">${icon('work', 18)}委托工作</button><button data-action="new-deep">${icon('layers', 18)}发起深聊</button><button data-action="new-event">${icon('event', 18)}投递事件</button>${isGroup ? `<div class="menu-separator"></div><label for="message-target">消息对象</label>` : ''}</div>` : '';
  return `<div data-room-id="${esc(ui.roomId)}" data-ready="${ui.messagesRoomId === ui.roomId}" class="chat-layout ${ui.detailOpen ? 'detail-open' : ''}" style="--accent:${esc(accent)}"><section class="conversation"><div class="floating-header"><button class="mobile-back icon-button" data-action="room-back" aria-label="返回会话">${icon('back', 23)}</button><button class="chat-title-pill" data-action="toggle-details" aria-expanded="${!!ui.detailOpen}" title="查看${isGroup ? '会话' : 'Bot'}详情">${bot ? avatar(bot.id, 39, 'slot:title') : groupAvatar(room, 38, 'slot:title-group')}<span>${esc(title)}</span></button></div>${room ? `<div class="messages ${isGroup ? 'group-messages' : ''}" role="log" aria-label="聊天记录">${messages || `<div class="conversation-empty">${bot ? avatar(bot.id, 104, 'slot:empty') : groupAvatar(room, 98)}<span>${esc(title)}</span><p>${esc(ui.messagesRoomId === ui.roomId ? room.goal || '发一条消息开始聊天' : '正在读取消息…')}</p></div>`}${roomNotices(room)}<div class="typing-status">${jobs.length ? `${avatar(jobs[0].botId, 43, `typing:${ui.roomId}`)}<span>${jobs.some(job => job.status === 'running') ? '正在处理' : '等待回复'}<span class="typing-ellipsis">…</span></span>` : ''}</div></div><div class="composer-wrap">${room.status === 'concluded' ? `<div class="closed-notice">深聊已结束 <button class="text-button" data-action="new-deep">发起新的深聊</button></div>` : `${ui.reply ? `<div class="reply-preview"><span>回复 ${esc(nameOf(ui.reply.senderId))}：${esc(ui.reply.content?.slice(0, 100))}</span><button class="icon-button" data-action="cancel-reply" aria-label="取消回复">${icon('close', 16)}</button></div>` : ''}<form id="message-form" class="composer" data-room-id="${esc(ui.roomId)}"><div class="menu-anchor"><button class="composer-plus" type="button" data-action="toggle-composer" aria-label="更多操作">${icon('plus', 28)}</button>${extraMenu}</div><textarea id="message-input" name="content" rows="1" aria-label="消息内容" placeholder="给 ${esc(title)} 发消息" required>${esc(ui.drafts[ui.roomId] || '')}</textarea><select id="message-target" class="message-target ${isGroup ? '' : 'visually-hidden'}" aria-label="消息对象"><option value="">${isGroup ? '@' : '成员'}</option>${members.map(item => `<option value="${esc(item.id)}" ${ui.draftTargets[ui.roomId] === item.id ? 'selected' : ''}>@ ${esc(item.name)}</option>`).join('')}</select><button type="submit" class="composer-send" ${ui.sendingRooms.has(ui.roomId) ? 'disabled' : ''} title="发送消息" aria-label="发送消息">${icon('send', 22)}</button></form>`}</div>` : `<div class="conversation-empty"><p>选择一位 Bot，开始聊天</p><button class="secondary-button" data-action="new-bot">创建新 Bot</button></div>`}</section>${ui.detailOpen ? renderDetailPanel(room, profileBot()) : ''}</div>`;
}
function renderDetailPanel(room, bot) {
  const tab = ui.detailTab || 'details', isBot = !!bot;
  const ownedRoutines = state.routines.filter(routine => isBot ? routine.botId === bot.id : routine.roomId === room?.id);
  const ownedWorks = state.works.filter(work => isBot ? work.botId === bot.id : work.roomId === room?.id);
  const selectedAvatar = ui.avatarEditing ? ui.avatarDraft || botAvatar(bot) : botAvatar(bot);
  let body = '';
  if (ui.avatarEditing && bot) body = renderAvatarPicker('edit');
  else if (tab === 'members' && !isBot) body = `<div class="profile-members">${(room?.members || []).filter(id => id !== 'user').map(id => `<button data-action="open-bot-details" data-id="${esc(id)}">${avatar(id, 50)}<span>${esc(nameOf(id))}</span></button>`).join('')}<button class="add-member" data-action="edit-room-members">${icon('plus', 24)}<span>添加成员</span></button></div>`;
  else if (tab === 'library') body = `<div class="profile-section-heading"><span>${isBot ? '记忆' : '共享知识'}</span><button class="icon-button" data-action="${isBot ? 'new-memory' : 'new-node'}" aria-label="${isBot ? '添加记忆' : '新增知识'}">${icon('plus', 20)}</button></div>${isBot ? ui.memories.map(memory => `<article class="profile-record"><p>${esc(memory.content)}</p><div class="item-meta">${esc(labels[memory.category] || '记忆')} · ${memory.status === 'expired' ? '已过期' : '有效'}<button class="text-button" data-action="edit-memory" data-id="${esc(memory.id)}">修订</button></div></article>`).join('') || '<p class="panel-empty">还没有记忆</p>' : ''}${(state.knowledge.nodes || []).map(node => `<button class="profile-record record-button" data-action="open-knowledge" data-id="${esc(node.id)}"><strong>${esc(node.title)}</strong><p>${esc(node.content?.slice(0, 150))}</p></button>`).join('') || (!isBot ? '<p class="panel-empty">还没有知识记录</p>' : '')}<button class="panel-footer-link" data-action="navigate" data-view="knowledge">查看全部知识 ${icon('arrow', 17)}</button>`;
  else if (tab === 'computer') body = `<div class="profile-section-heading"><span>Codex 工作</span><button class="icon-button" data-action="new-work" aria-label="委托工作">${icon('plus', 20)}</button></div>${ownedWorks.map(work => `<button class="profile-record record-button" data-action="open-work" data-id="${esc(work.id)}"><strong>${esc(work.goal)}</strong><div class="item-meta">${statusPill(work.status)}</div></button>`).join('') || '<p class="panel-empty">还没有委托工作</p>'}<button class="panel-footer-link" data-action="navigate" data-view="works">查看所有工作 ${icon('arrow', 17)}</button>`;
  else body = `${isBot ? `<button class="profile-description" data-action="edit-bot" data-id="${esc(bot.id)}"><span>${esc(bot.role || '项目协作')}</span>${icon('edit', 16)}</button>${bot.prompt ? `<p class="profile-prompt">${esc(bot.prompt)}</p>` : ''}${bot.skills?.length ? `<div class="tag-list">${bot.skills.map(skill => `<span class="tag">${esc(skill)}</span>`).join('')}</div>` : ''}` : `<button class="profile-description" data-action="edit-room"><span>${esc(room?.goal || '添加群聊说明')}</span>${icon('edit', 16)}</button>`}<div class="profile-section-heading"><span>例行任务</span><button class="icon-button" data-action="new-routine" aria-label="新增职责">${icon('plus', 20)}</button></div>${ownedRoutines.map(routine => `<div class="profile-routine"><button class="routine-text" data-action="edit-routine" data-id="${esc(routine.id)}"><strong>${esc(routine.name)}</strong><span>每 ${Math.round(routine.intervalSeconds / 60)} 分钟</span></button><button class="toggle ${routine.enabled ? 'on' : ''}" data-action="toggle-routine" data-id="${esc(routine.id)}" role="switch" aria-checked="${!!routine.enabled}" aria-label="${routine.enabled ? '暂停' : '启用'}${esc(routine.name)}"></button></div>`).join('') || '<p class="panel-empty">没有例行任务</p>'}<div class="profile-more-actions">${isBot ? `<button data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot 资料</button><button data-action="toggle-bot" data-id="${esc(bot.id)}">${bot.status === 'paused' ? '恢复 Bot' : '暂停 Bot'}</button>` : `<button data-action="new-deep">发起深聊</button>${room?.kind === 'deep' && room.status !== 'concluded' ? '<button data-action="conclude-room">结束深聊并保留结论</button>' : ''}<button data-action="new-work">委托工作</button>`}</div>`;
  return `<aside class="detail-panel" data-section="${ui.avatarEditing ? `avatar:${ui.avatarTab}` : tab}:${bot?.id || room?.id}"><div class="detail-panel-inner"><div class="detail-panel-toolbar"><button class="round-button" data-action="copy-conversation" title="复制会话文字" aria-label="复制会话文字">${icon('copy', 21)}</button><button class="round-button" data-action="close-details" title="关闭详情" aria-label="关闭详情">${icon('close', 26)}</button></div><div class="profile-identity ${ui.avatarEditing ? 'editing-avatar' : ''}">${isBot ? `<button class="profile-avatar" data-action="edit-avatar" data-id="${esc(bot.id)}" aria-label="编辑头像" title="编辑头像">${face(selectedAvatar, 104, { key: 'slot:profile', identity: `bot:${bot.id}`, preview: true, intro: true })}<span class="avatar-pencil">${icon('edit', 23)}</span></button>` : groupAvatar(room, 104)}${!ui.avatarEditing ? `<h2>${esc(bot?.name || room?.name)}</h2>${isBot ? `<button class="profile-subtitle" data-action="edit-bot" data-id="${esc(bot.id)}">${esc(listText(bot.expertise) || '添加专业标签')}</button>` : ''}` : ''}</div>${!ui.avatarEditing ? `<nav class="profile-tabs" aria-label="详情分类">${[{ id: 'details', label: '详情' }, { id: 'library', label: '资料库' }, { id: isBot ? 'computer' : 'members', label: isBot ? '电脑' : '成员' }].map(item => `<button class="${tab === item.id ? 'active' : ''}" data-action="detail-tab" data-tab="${item.id}">${item.label}</button>`).join('')}</nav>` : ''}<div class="detail-panel-body" data-motion-key="detail-content">${body}</div></div></aside>`;
}
function renderAvatarPicker(mode = 'create') {
  const selected = ui.avatarDraft || botAvatar(profileBot()), tab = ui.avatarTab || 'bot';
  const save = mode === 'edit' ? avatarSaves.get(profileBot()?.id) : null;
  const saveStatus = save?.error ? `<div class="avatar-save-status error" role="status">头像尚未保存<button type="button" data-action="avatar-save-retry">重试</button><small>${esc(save.error)}</small></div>` : save && (save.running || save.savedVersion !== save.version) ? '<div class="avatar-save-status" role="status">正在保存…</div>' : mode === 'edit' ? '<div class="avatar-save-status" aria-hidden="true"></div>' : '';
  const picker = `<div class="shape-grid">${(window.RelayAvatars?.shapes || []).map(shape => `<button type="button" class="shape-choice ${selected.shape === shape.id && !selected.image ? 'selected' : ''}" data-action="avatar-shape" data-shape="${esc(shape.id)}" data-mode="${mode}" aria-label="${esc(shape.label)}" title="${esc(shape.label)}" aria-pressed="${selected.shape === shape.id && !selected.image}">${face({ shape: shape.id, color: selected.color }, 64, { key: `picker:${mode}:${shape.id}`, static: true })}</button>`).join('')}</div><div class="color-grid">${(window.RelayAvatars?.colors || []).map(color => `<button type="button" class="color-choice ${selected.color?.toLowerCase() === color.toLowerCase() ? 'selected' : ''}" style="--swatch:${color}" data-action="avatar-color" data-color="${color}" data-mode="${mode}" aria-label="颜色 ${color}" title="${color}" aria-pressed="${selected.color?.toLowerCase() === color.toLowerCase()}"></button>`).join('')}</div>`;
  return `${saveStatus}<div class="avatar-picker ${mode === 'create' ? 'create-picker' : ''}">${mode === 'edit' ? `<div class="avatar-tabs">${[{ id: 'bot', label: 'Bot' }, { id: 'generate', label: '生成' }, { id: 'upload', label: '上传' }].map(item => `<button type="button" class="${tab === item.id ? 'active' : ''}" data-action="avatar-tab" data-tab="${item.id}">${item.label}</button>`).join('')}<button class="avatar-reset" type="button" data-action="avatar-reset">重置</button></div>` : ''}${mode === 'create' || tab === 'bot' ? picker : tab === 'generate' ? `<div class="avatar-tool"><p>随机组合造型与颜色</p><button class="secondary-button" data-action="avatar-random" type="button">${icon('spark', 18)}生成一个造型</button></div>` : `<div class="avatar-tool"><p>使用自己的图片</p><label class="upload-label" for="avatar-upload">${icon('upload', 23)}选择图片</label><input id="avatar-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden><small>PNG、JPG 或 WebP，将缩放后保存在本机</small></div>`}</div>`;
}
function openCreateBot() {
  ui.avatarSelectionRevision++;
  ui.avatarEditing = false;
  ui.avatarDraft = { shape: 'clover', color: '#8F59F9', image: null };
  ui.menu = null; render();
  const modal = $('#modal'); captureMotion($('#modal-content')); modal.classList.add('create-bot-modal');
  $('#modal-content').innerHTML = `<div class="modal-header"><h2>创建新 Bot</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 24)}</button></div><form id="modal-form" class="create-bot-form"><div class="create-bot-body"><div id="create-avatar-preview" class="create-avatar-preview">${face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true })}</div><input id="create-bot-name" name="name" placeholder="给你的 Bot 起个名字" aria-label="Bot 名字" required maxlength="100" autocomplete="off"><div class="create-picker-scroll"><div id="create-avatar-picker">${renderAvatarPicker('create')}</div><div class="form-error" role="alert"></div></div></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button id="create-bot-submit" class="primary-button" type="submit" disabled>创建</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = $('#create-bot-submit', form), name = $('#create-bot-name', form).value.trim(), avatar = { ...ui.avatarDraft }; if (!name) return;
    button.disabled = true; $('.form-error', event.target).textContent = '';
    try { const bot = await api('/api/bots', 'POST', { name, role: '项目协作', avatar }); const ownsDialog = modal.open && $('#modal-form') === form; if (ownsDialog) await closeModal(modal); const stillOwns = $('#modal-form') === form; if (ownsDialog && stillOwns) ui.avatarDraft = null; await refresh(); if (ownsDialog && stillOwns && $('#modal-form') === form) await act('dm-bot', { dataset: { id: bot.id } }); else toast(`${bot.name} 已创建`); }
    catch (error) { if (form.isConnected) $('.form-error', form).textContent = error.message; else toast(error.message, true); } finally { button.disabled = false; }
  };
  showModal(modal); $('#create-bot-name').focus();
}
async function persistAvatar() {
  const bot = profileBot(); if (!bot) return;
  const botId = bot.id;
  let entry = avatarSaves.get(botId);
  if (!entry) { entry = { version: 0, savedVersion: 0, running: false, error: null, target: null }; avatarSaves.set(botId, entry); }
  entry.target = { ...ui.avatarDraft }; entry.version++; entry.error = null;
  bot.avatar = { ...entry.target }; render();
  if (entry.running) return entry.promise;
  entry.running = true;
  entry.promise = (async () => {
    while (entry.savedVersion !== entry.version) {
      const version = entry.version, target = { ...entry.target };
      try {
        const saved = await api(`/api/bots/${encodeURIComponent(botId)}`, 'PATCH', { avatar: target });
        entry.savedVersion = version;
        if (version === entry.version) {
          const current = botById(botId); if (current) Object.assign(current, saved);
          if (profileBot()?.id === botId && ui.avatarEditing) ui.avatarDraft = { ...saved.avatar };
        }
      } catch (error) {
        if (version !== entry.version) continue;
        entry.error = error.message; toast(`头像未保存：${error.message}`, true); break;
      }
    }
    entry.running = false;
    if (!entry.error && entry.savedVersion === entry.version) { entry.confirmedEpoch = ++avatarSaveEpoch; scheduleRefresh(); }
    render();
    return !entry.error;
  })();
  return entry.promise;
}
function updateAvatarPicker(mode) {
  if (mode === 'create') { const root = $('#modal-content'), motion = captureMotion(root); $('#create-avatar-preview').innerHTML = face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true }); $('#create-avatar-picker').innerHTML = renderAvatarPicker('create'); hydrateMotion(root, motion); }
  else return persistAvatar();
}
function openRoomEdit(membersOnly = false) {
  const room = roomById(ui.roomId); if (!room || room.kind === 'dm') return;
  openModal(membersOnly ? '群聊成员' : '群聊详情', '', `${!membersOnly ? `${field('群聊名称', 'name', room.name, { required: true })}${field('群聊说明', 'goal', room.goal || '', { type: 'textarea' })}` : ''}${memberChoices((room.members || []).filter(id => id !== 'user'))}`, async data => {
    const members = data.getAll('members'); if (!members.length) throw new Error('群聊至少需要一位 Bot。');
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, 'PATCH', { members: room.members.includes('user') ? ['user', ...members] : members, ...(!membersOnly ? { name: data.get('name').trim(), goal: data.get('goal').trim() } : {}) }); toast('群聊已更新');
  });
}

document.addEventListener('change', async event => {
  if (event.target.id === 'message-target') ui.draftTargets[event.target.form.dataset.roomId] = event.target.value;
  if (event.target.id !== 'avatar-upload') return;
  const file = event.target.files?.[0], botId = profileBot()?.id;
  if (!file || !botId) return;
  const revision = ++ui.avatarSelectionRevision;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file); });
    const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法打开这张图片。')); image.src = source; });
    const canvas = document.createElement('canvas'), ratio = Math.min(1, 256 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * ratio)); canvas.height = Math.max(1, Math.round(img.height * ratio));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/png');
    if (image.length > 400000) throw new Error('这张图片缩放后仍然过大，请选择较小的图片。');
    if (profileBot()?.id !== botId || !ui.avatarEditing || revision !== ui.avatarSelectionRevision) return;
    ui.avatarDraft = { ...ui.avatarDraft, image }; if (await persistAvatar()) toast('头像已更新');
  } catch (error) { if (revision === ui.avatarSelectionRevision) toast(error.message, true); }
});

const initialView = location.hash.slice(1); if (tabs.some(tab => tab.id === initialView)) ui.view = initialView;
renderTopbar(); refresh();
const stream = new EventSource('/api/stream');
stream.onopen = () => { const wasConnected = ui.streamConnected; ui.streamConnected = true; if (!wasConnected) scheduleRefresh(); };
stream.onmessage = () => scheduleRefresh();
stream.addEventListener('change', () => scheduleRefresh());
stream.addEventListener('state', () => scheduleRefresh());
stream.onerror = () => { ui.streamConnected = false; showConnection('实时连接已断开，正在自动重连。已显示的记录仍然保留。'); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
