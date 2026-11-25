(() => {
  'use strict';

  const DEFAULT_HUB_URL = 'https://bot.lin0.org';
  const PROTOCOL_VERSION = 3;
  const LAST_NODE_KEY = 'summon:hub:active-node:v1';

  const hub = {
    initialized: false,
    mode: 'local', // 'hub' | 'local'
    authenticated: false,
    localOnlyAvailable: false,
    user: null,
    hubUrl: DEFAULT_HUB_URL,
    hubConnected: false,
    hubError: '',
    localNodeId: null,
    localNodeName: '',
    maxUploadMb: 20,
    nodes: [],
    activeNodeId: null,
    filterNodeId: 'all',
    nodeSnapshots: new Map(), // nodeId -> { rooms, archivedRooms, bots, updatedAt }
    invites: [],
    invitesLoaded: false,
    sse: null,
    sseConnected: false,
    callbacks: null,
    remoteTimers: new Map(),
    authScreenOpen: false,
    authMode: 'login',
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function onlineNodes() {
    return hub.nodes.filter(n => n.online);
  }

  function offlineNodes() {
    return hub.nodes.filter(n => !n.online);
  }

  function nodeById(id) {
    return hub.nodes.find(n => n.id === id) || null;
  }

  function nodeLabel(id) {
    const n = nodeById(id);
    if (!n) return '';
    return n.name || n.hostname || 'PC';
  }

  function apiPath(path, nodeId = hub.activeNodeId) {
    if (typeof path !== 'string') return path;
    if (!path.startsWith('/api/')) return path;
    if (path === '/api/releases' || path.startsWith('/api/releases/')) return path;
    const target = nodeId || hub.activeNodeId;
    if (!target) return path;
    return `/nodes/${encodeURIComponent(target)}${path}`;
  }

  function pickDefaultActiveNode() {
    const online = onlineNodes();
    if (hub.activeNodeId && online.some(n => n.id === hub.activeNodeId)) return hub.activeNodeId;
    const saved = (() => { try { return localStorage.getItem(LAST_NODE_KEY); } catch { return null; } })();
    if (saved && online.some(n => n.id === saved)) return saved;
    if (hub.localNodeId && online.some(n => n.id === hub.localNodeId)) return hub.localNodeId;
    return online[0]?.id || null;
  }

  async function hubRequest(path, method = 'GET', body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status, code: data.code });
    }
    return data;
  }

  async function fetchRemoteNodeSnapshot(nodeId) {
    if (!nodeId || nodeId === hub.activeNodeId) return;
    const node = nodeById(nodeId);
    if (!node || !node.online) return;
    try {
      const res = await fetch(`/nodes/${encodeURIComponent(nodeId)}/api/state`, {
        headers: { 'X-Summon-Protocol': String(PROTOCOL_VERSION), Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      const snap = data.snapshot || data;
      hub.nodeSnapshots.set(nodeId, {
        rooms: Array.isArray(snap.rooms) ? snap.rooms : [],
        archivedRooms: Array.isArray(snap.archivedRooms) ? snap.archivedRooms : [],
        bots: Array.isArray(snap.bots) ? snap.bots : [],
        updatedAt: Date.now(),
      });
      hub.callbacks?.onNodesUpdated?.();
    } catch {}
  }

  function scheduleRemoteNodeRefresh(nodeId) {
    if (!nodeId || nodeId === hub.activeNodeId) return;
    if (hub.remoteTimers.has(nodeId)) return;
    const timer = setTimeout(() => {
      hub.remoteTimers.delete(nodeId);
      void fetchRemoteNodeSnapshot(nodeId);
    }, 450);
    hub.remoteTimers.set(nodeId, timer);
  }

  function syncActiveSnapshot(state) {
    if (!hub.activeNodeId || !state) return;
    hub.nodeSnapshots.set(hub.activeNodeId, {
      rooms: Array.isArray(state.rooms) ? state.rooms : [],
      archivedRooms: Array.isArray(state.archivedRooms) ? state.archivedRooms : [],
      bots: Array.isArray(state.bots) ? state.bots : [],
      updatedAt: Date.now(),
    });
  }

  async function loadAllOnlineSnapshots() {
    const targets = onlineNodes().filter(n => n.id !== hub.activeNodeId);
    await Promise.allSettled(targets.map(n => fetchRemoteNodeSnapshot(n.id)));
  }

  function applyNodes(list) {
    if (!Array.isArray(list)) return;
    const prevOnline = new Set(onlineNodes().map(n => n.id));
    hub.nodes = list;
    const localNode = list.find(n => n.isLocal);
    if (localNode && typeof localNode.hubConnected === 'boolean') {
      hub.hubConnected = localNode.hubConnected;
      if (localNode.hubConnected) hub.hubError = '';
    }
    const nextOnline = new Set(onlineNodes().map(n => n.id));
    if (hub.filterNodeId !== 'all' && !hub.nodes.some(n => n.id === hub.filterNodeId)) {
      hub.filterNodeId = 'all';
    }
    for (const id of [...hub.nodeSnapshots.keys()]) {
      if (!nextOnline.has(id)) hub.nodeSnapshots.delete(id);
    }
    const prevActive = hub.activeNodeId;
    const nextActive = pickDefaultActiveNode();
    hub.activeNodeId = nextActive;
    for (const id of nextOnline) {
      if (!prevOnline.has(id) && id !== hub.activeNodeId) {
        void fetchRemoteNodeSnapshot(id);
      }
    }
    if (prevActive !== nextActive) {
      hub.callbacks?.onActiveNodeChanged?.(nextActive);
    } else {
      hub.callbacks?.onNodesUpdated?.();
    }
  }

  function upsertNode(node) {
    if (!node?.id) return;
    const idx = hub.nodes.findIndex(n => n.id === node.id);
    const next = [...hub.nodes];
    if (idx >= 0) next[idx] = { ...next[idx], ...node };
    else next.push(node);
    applyNodes(next);
  }

  function connectEvents() {
    if (hub.sse) {
      try { hub.sse.close(); } catch {}
      hub.sse = null;
    }
    if (hub.mode === 'hub' && !hub.authenticated) return;
    const sse = new EventSource('/hub/events');
    hub.sse = sse;
    sse.onopen = () => {
      hub.sseConnected = true;
      hub.callbacks?.onStreamState?.(true);
    };
    sse.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connected' || msg.type === 'nodes.sync') {
        if (Array.isArray(msg.nodes)) applyNodes(msg.nodes);
        return;
      }
      if (msg.type === 'node.status' && msg.node) {
        upsertNode(msg.node);
        return;
      }
      if (msg.type === 'node.removed' && msg.nodeId) {
        applyNodes(hub.nodes.filter(n => n.id !== msg.nodeId));
        return;
      }
      if (msg.type === 'node.event' && msg.nodeId) {
        if (msg.nodeId === hub.activeNodeId) {
          hub.callbacks?.onActiveNodeEvent?.(msg.event);
        } else {
          scheduleRemoteNodeRefresh(msg.nodeId);
        }
      }
    };
    sse.onerror = () => {
      hub.sseConnected = false;
      hub.callbacks?.onStreamState?.(false);
    };
  }

  async function refreshNodes() {
    try {
      const data = await hubRequest('/hub/nodes');
      applyNodes(data.nodes || []);
      await loadAllOnlineSnapshots();
    } catch {}
  }

  async function init(callbacks) {
    hub.callbacks = callbacks;
    try {
      const res = await fetch('/hub/auth/me', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 401) {
        hub.mode = 'hub';
        hub.authenticated = false;
        hub.initialized = true;
        openAuthOverlay({ mode: 'login', dismissible: false });
        return { ready: false, requiresAuth: true };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const me = await res.json();
      applyAuthMe(me);
      hub.initialized = true;
      await refreshNodes();
      connectEvents();
      return { ready: true, activeNodeId: hub.activeNodeId };
    } catch {
      // Fallback: legacy single-node mode without /hub/*
      hub.mode = 'local';
      hub.initialized = true;
      return { ready: true, activeNodeId: null };
    }
  }

  function applyAuthMe(me) {
    hub.mode = me.mode || 'hub';
    hub.authenticated = Boolean(me.authenticated ?? me.user);
    hub.localOnlyAvailable = Boolean(me.localOnlyAvailable);
    hub.user = me.user || null;
    hub.hubUrl = me.hubUrl || DEFAULT_HUB_URL;
    hub.hubConnected = Boolean(me.hubConnected);
    hub.hubError = me.hubError || '';
    hub.localNodeId = me.localNodeId || null;
    hub.localNodeName = me.localNodeName || '';
    if (typeof me.maxUploadMb === 'number') hub.maxUploadMb = me.maxUploadMb;
  }

  async function switchNode(nodeId, { refresh = true } = {}) {
    if (!nodeId || nodeId === hub.activeNodeId) return false;
    const node = nodeById(nodeId);
    if (!node || !node.online) return false;
    hub.activeNodeId = nodeId;
    try { localStorage.setItem(LAST_NODE_KEY, nodeId); } catch {}
    if (refresh) hub.callbacks?.onActiveNodeChanged?.(nodeId);
    return true;
  }

  function setFilterNode(nodeId) {
    hub.filterNodeId = nodeId || 'all';
    hub.callbacks?.onNodesUpdated?.();
  }

  function mixedRooms(activeRooms = [], { includeArchived = false, activeArchived = [] } = {}) {
    const online = onlineNodes();
    if (!online.length) return [];
    const results = [];
    for (const node of online) {
      if (hub.filterNodeId !== 'all' && hub.filterNodeId !== node.id) continue;
      let list;
      if (node.id === hub.activeNodeId) {
        list = includeArchived ? activeArchived : activeRooms;
      } else {
        const snap = hub.nodeSnapshots.get(node.id);
        list = snap ? (includeArchived ? snap.archivedRooms : snap.rooms) : [];
      }
      for (const room of list || []) {
        results.push({
          ...room,
          _nodeId: node.id,
          _nodeName: node.name || node.hostname || 'PC',
          _isLocal: Boolean(node.isLocal),
        });
      }
    }
    return results;
  }

  function botsForNode(nodeId, activeBots = []) {
    if (!nodeId || nodeId === hub.activeNodeId) return activeBots;
    return hub.nodeSnapshots.get(nodeId)?.bots || [];
  }

  // --- Auth Overlay (Paper / Midnight native styling) ---
  function closeAuthOverlay() {
    hub.authScreenOpen = false;
    document.getElementById('summon-hub-auth-overlay')?.remove();
  }

  function openAuthOverlay({ mode = 'login', dismissible = hub.mode === 'local' } = {}) {
    hub.authScreenOpen = true;
    hub.authMode = mode;
    let root = document.getElementById('summon-hub-auth-overlay');
    if (!root) {
      root = document.createElement('div');
      root.id = 'summon-hub-auth-overlay';
      root.className = 'hub-auth-overlay';
      document.body.appendChild(root);
    }
    const isReg = mode === 'register';
    const isLocal = hub.mode === 'local';
    root.innerHTML = `<div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="${isReg ? '注册 Summon Bot 账号' : '登录 Summon Bot'}">
      <div class="hub-auth-head">
        <div>
          <h1>Summon Bot</h1>
          <p>${isLocal ? '登录云端账号即可在手机和其他电脑互联；也可以暂不登录，先使用本地账户。' : '连接你的多台在线电脑，随时掌控所有群聊与 Agent。'}</p>
        </div>
        ${dismissible ? '<button type="button" class="icon-button hub-auth-close" data-hub-action="close-auth" aria-label="关闭">✕</button>' : ''}
      </div>
      <div class="hub-auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="${!isReg}" class="${!isReg ? 'active' : ''}" data-hub-action="auth-tab" data-mode="login">账号登录</button>
        <button type="button" role="tab" aria-selected="${isReg}" class="${isReg ? 'active' : ''}" data-hub-action="auth-tab" data-mode="register">邀请码注册</button>
      </div>
      <form class="hub-auth-form" id="hub-auth-form">
        ${isReg ? `<label class="hub-field"><span>邀请码</span><input name="inviteCode" required autocomplete="off" placeholder="例如 SUMMON-XXXX-XXXX-XXXX"></label>` : ''}
        <label class="hub-field"><span>用户名</span><input name="username" required autocomplete="username" placeholder="2–32 位字母或数字"></label>
        ${isReg ? `<label class="hub-field"><span>显示名称（可选）</span><input name="displayName" autocomplete="name" placeholder="你的昵称"></label>` : ''}
        <label class="hub-field"><span>密码</span><input name="password" type="password" required autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="${isReg ? '至少 8 位密码' : '输入密码'}"></label>
        ${isLocal ? `<label class="hub-field"><span>这台电脑的名称</span><input name="nodeName" value="${esc(hub.localNodeName || '')}" placeholder="例如 家里的台式机 / 公司 Mac"></label>` : ''}
        ${isLocal ? `<details class="hub-advanced"><summary>中枢服务器地址（可改自部署）</summary><label class="hub-field"><span>中枢 URL</span><input name="hubUrl" value="${esc(hub.hubUrl || DEFAULT_HUB_URL)}" placeholder="${DEFAULT_HUB_URL}"></label></details>` : ''}
        <p class="hub-auth-error" id="hub-auth-error" role="alert" hidden></p>
        <button type="submit" class="primary-button hub-auth-submit">${isReg ? '注册并连接' : '登录'}</button>
      </form>
      ${dismissible ? '<button type="button" class="text-button hub-auth-skip" data-hub-action="choose-local">暂不登录，先使用本地账户</button>' : ''}
    </div>`;

    const form = root.querySelector('#hub-auth-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const errEl = root.querySelector('#hub-auth-error');
      const submitBtn = root.querySelector('.hub-auth-submit');
      errEl.hidden = true;
      submitBtn.disabled = true;
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      try {
        const endpoint = isReg ? '/hub/auth/register' : '/hub/auth/login';
        const res = await hubRequest(endpoint, 'POST', payload);
        if (hub.mode === 'local') {
          applyAuthMe(res);
        } else {
          hub.authenticated = true;
          hub.user = res.user;
          if (typeof res.maxUploadMb === 'number') hub.maxUploadMb = res.maxUploadMb;
        }
        closeAuthOverlay();
        await refreshNodes();
        connectEvents();
        hub.callbacks?.onAuthSuccess?.();
      } catch (error) {
        errEl.textContent = error.message || '登录失败，请检查信息后重试';
        errEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    };
  }

  function renderNodeFilterBar() {
    const online = onlineNodes();
    const offline = offlineNodes();
    const total = hub.nodes.length;

    // On local desktop when not signed in to Hub, keep the sidebar top clean (login entry lives on the bottom-left avatar & settings).
    if (hub.mode === 'local' && !hub.authenticated) {
      return '';
    }

    if (total <= 1 && !offline.length) return '';

    const pills = [
      `<button type="button" class="hub-node-pill ${hub.filterNodeId === 'all' ? 'active' : ''}" data-hub-action="filter-node" data-node-id="all">全部 <span class="hub-pill-count">${online.length}</span></button>`,
      ...online.map(n => `<button type="button" class="hub-node-pill ${hub.filterNodeId === n.id ? 'active' : ''}" data-hub-action="filter-node" data-node-id="${esc(n.id)}" title="${esc(n.hostname || n.name)}"><i class="hub-dot is-online"></i><span>${esc(n.name)}</span></button>`),
      ...offline.map(n => `<button type="button" class="hub-node-pill is-offline" data-action="open-settings" data-tab="connection" title="离线电脑 · 点击可在连接设置中管理或解绑"><i class="hub-dot is-offline"></i><span>${esc(n.name)}</span><em>离线</em></button>`),
    ];
    return `<div class="hub-node-strip" role="tablist" aria-label="电脑节点筛选">${pills.join('')}</div>`;
  }

  function renderNoOnlineNodesEmpty() {
    const offline = offlineNodes();
    return `<div class="hub-empty-online">
      <div class="hub-empty-card">
        <h2>当前没有在线电脑</h2>
        <p>${offline.length ? `你已绑定 ${offline.length} 台电脑，目前均处于离线状态。开机运行 Summon Bot 桌面端后，群聊会自动出现。` : '请在你的电脑上安装并打开 Summon Bot 桌面端，使用同一账号登录后即可远程操控。'}</p>
        ${offline.length ? `<div class="hub-empty-nodes">${offline.map(n => `<span class="hub-node-pill is-offline"><i class="hub-dot is-offline"></i>${esc(n.name)} · 离线</span>`).join('')}</div>` : ''}
        <div class="hub-empty-actions">
          <button type="button" class="primary-button" data-action="open-settings">打开设置 / 下载桌面端</button>
          <button type="button" class="secondary-button" data-hub-action="refresh-nodes">重新检查</button>
        </div>
      </div>
    </div>`;
  }

  function renderHubSettingsSection() {
    const online = onlineNodes();
    const isAdmin = hub.user?.role === 'admin';
    const accountCard = hub.authenticated && hub.user
      ? `<div class="settings-section">
          <h3 class="settings-group-label">中枢账号与多电脑互联</h3>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-copy">
                <strong>${esc(hub.user.displayName || hub.user.username)} <span class="settings-pill">${hub.user.role === 'admin' ? '管理员' : '成员'}</span></strong>
                <small><i class="settings-status-dot ${(hub.mode === 'hub' ? hub.sseConnected : hub.hubConnected) ? 'is-ok' : 'is-warn'}" aria-hidden="true"></i>@${esc(hub.user.username)} · ${esc(hub.mode === 'local' ? hub.hubUrl : location.origin)}${hub.mode === 'local' ? (hub.hubConnected ? ' · 隧道已连接' : ` · ${hub.hubError || '正在重连'}`) : ''}</small>
              </div>
              <div class="settings-row-actions">
                <button type="button" class="secondary-button small-button" data-hub-action="refresh-nodes">刷新节点</button>
                <button type="button" class="secondary-button small-button" data-hub-action="logout">退出账号</button>
              </div>
            </div>
          </div>
        </div>`
      : `<div class="settings-section">
          <h3 class="settings-group-label">多电脑中枢互联</h3>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-copy">
                <strong>尚未登录云端中枢</strong>
                <small>登录或使用邀请码注册后，即可在手机和其他电脑上随时访问这台电脑的群聊</small>
              </div>
              <div class="settings-row-actions">
                <button type="button" class="primary-button small-button" data-hub-action="open-login">登录 / 注册</button>
              </div>
            </div>
          </div>
        </div>`;

    const nodesCard = `<div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">已绑定电脑节点（${online.length} 台在线）</h3>
      </div>
      <div class="settings-card">
        ${hub.nodes.length ? hub.nodes.map(n => `<div class="settings-row">
          <div class="settings-row-copy">
            <strong><i class="hub-dot ${n.online ? 'is-online' : 'is-offline'}"></i> ${esc(n.name)}${n.isLocal ? ' <span class="settings-pill">本机直连</span>' : ''}${n.id === hub.activeNodeId ? ' <span class="settings-pill">当前配置目标</span>' : ''}</strong>
            <small>${n.online ? '在线' : '离线'}${n.hostname ? ' · ' + esc(n.hostname) : ''}${n.platform && n.platform !== 'unknown' ? ' · ' + esc(n.platform) : ''}</small>
          </div>
          <div class="settings-row-actions">
            ${n.online && n.id !== hub.activeNodeId ? `<button type="button" class="secondary-button small-button" data-hub-action="switch-node" data-node-id="${esc(n.id)}">切换到此电脑</button>` : ''}
            <button type="button" class="text-button" data-hub-action="rename-node" data-node-id="${esc(n.id)}">改名</button>
            ${hub.authenticated ? `<button type="button" class="text-button danger-text" data-hub-action="delete-node" data-node-id="${esc(n.id)}">解绑</button>` : ''}
          </div>
        </div>`).join('') : '<div class="settings-row"><div class="settings-row-copy"><strong>暂无绑定节点</strong></div></div>'}
      </div>
    </div>`;

    const invitesCard = isAdmin ? `<div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">试用邀请码（管理员）</h3>
        <button type="button" class="primary-button small-button" data-hub-action="create-invite">生成邀请码</button>
      </div>
      <div class="settings-card">
        ${hub.invites.length ? hub.invites.slice(0, 15).map(inv => {
          const exhausted = inv.revoked || inv.used_count >= inv.max_uses;
          return `<div class="settings-row">
            <div class="settings-row-copy">
              <strong><code>${esc(inv.code)}</code> <span class="settings-pill">${inv.used_count}/${inv.max_uses}</span>${exhausted ? ' <span class="settings-pill">已失效</span>' : ''}</strong>
              <small>${esc(inv.note || '普通试用邀请码')}</small>
            </div>
            <div class="settings-row-actions">
              ${!exhausted ? `<button type="button" class="secondary-button small-button" data-hub-action="copy-invite" data-code="${esc(inv.code)}">复制</button>` : ''}
              ${!inv.revoked ? `<button type="button" class="text-button danger-text" data-hub-action="revoke-invite" data-code="${esc(inv.code)}">作废</button>` : ''}
            </div>
          </div>`;
        }).join('') : '<div class="settings-row"><div class="settings-row-copy"><strong>点击右上角「生成邀请码」即可分发给试用用户</strong></div></div>'}
      </div>
    </div>` : '';

    return accountCard + nodesCard + invitesCard;
  }

  async function loadInvites() {
    if (!hub.authenticated || hub.user?.role !== 'admin') return;
    try {
      const data = await hubRequest('/hub/admin/invites');
      hub.invites = data.invites || [];
      hub.invitesLoaded = true;
      hub.callbacks?.onNodesUpdated?.();
    } catch {}
  }

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-hub-action]');
    if (!btn) return;
    const action = btn.dataset.hubAction;
    if (action === 'close-auth') return closeAuthOverlay();
    if (action === 'choose-local') {
      closeAuthOverlay();
      hub.callbacks?.onChooseLocal?.();
      return;
    }
    if (action === 'auth-tab') return openAuthOverlay({ mode: btn.dataset.mode, dismissible: hub.mode === 'local' });
    if (action === 'open-login') return openAuthOverlay({ mode: 'login', dismissible: hub.mode === 'local' });
    if (action === 'filter-node') return setFilterNode(btn.dataset.nodeId);
    if (action === 'switch-node') return void switchNode(btn.dataset.nodeId);
    if (action === 'refresh-nodes') {
      await refreshNodes();
      hub.callbacks?.toast?.('节点状态已刷新');
      return;
    }
    if (action === 'logout') {
      try {
        await hubRequest('/hub/auth/logout', 'POST', {});
        hub.authenticated = false;
        hub.user = null;
        hub.hubConnected = false;
        if (hub.mode === 'hub') {
          hub.nodes = [];
          hub.activeNodeId = null;
          hub.sse?.close();
          openAuthOverlay({ mode: 'login', dismissible: false });
        } else {
          await refreshNodes();
          hub.callbacks?.onNodesUpdated?.();
          hub.callbacks?.toast?.('已退出中枢账号，当前仅本机可用');
        }
      } catch (e) { hub.callbacks?.toast?.(e.message, true); }
      return;
    }
    if (action === 'rename-node') {
      const id = btn.dataset.nodeId;
      const current = nodeById(id);
      const nextName = prompt('输入新的电脑名称：', current?.name || '');
      if (!nextName || !nextName.trim()) return;
      try {
        await hubRequest(`/hub/nodes/${encodeURIComponent(id)}`, 'PATCH', { name: nextName.trim() });
        await refreshNodes();
        hub.callbacks?.toast?.('电脑名称已更新');
      } catch (e) { hub.callbacks?.toast?.(e.message, true); }
      return;
    }
    if (action === 'delete-node') {
      const id = btn.dataset.nodeId;
      const current = nodeById(id);
      if (!confirm(`确定解绑电脑「${current?.name || id}」吗？该电脑本地聊天记录不会被删除，只是从云端中枢移除。`)) return;
      try {
        await hubRequest(`/hub/nodes/${encodeURIComponent(id)}`, 'DELETE');
        await refreshNodes();
        hub.callbacks?.toast?.('已解绑节点');
      } catch (e) { hub.callbacks?.toast?.(e.message, true); }
      return;
    }
    if (action === 'create-invite') {
      const note = prompt('邀请码备注（可选，例如：朋友试用）：', '') ?? '';
      try {
        const res = await hubRequest('/hub/admin/invites', 'POST', { maxUses: 1, days: 30, note });
        await loadInvites();
        if (res.invite?.code) {
          try { await navigator.clipboard.writeText(res.invite.code); hub.callbacks?.toast?.(`已生成并复制邀请码：${res.invite.code}`); }
          catch { hub.callbacks?.toast?.(`已生成邀请码：${res.invite.code}`); }
        }
      } catch (e) { hub.callbacks?.toast?.(e.message, true); }
      return;
    }
    if (action === 'copy-invite') {
      const code = btn.dataset.code;
      try { await navigator.clipboard.writeText(code); hub.callbacks?.toast?.(`已复制：${code}`); }
      catch { hub.callbacks?.toast?.(code); }
      return;
    }
    if (action === 'revoke-invite') {
      const code = btn.dataset.code;
      try {
        await hubRequest(`/hub/admin/invites/${encodeURIComponent(code)}`, 'DELETE');
        await loadInvites();
        hub.callbacks?.toast?.('邀请码已作废');
      } catch (e) { hub.callbacks?.toast?.(e.message, true); }
    }
  });

  async function applyAuthResult(res) {
    if (hub.mode === 'local') {
      applyAuthMe(res);
    } else {
      hub.authenticated = true;
      hub.user = res?.user || hub.user;
      if (typeof res?.maxUploadMb === 'number') hub.maxUploadMb = res.maxUploadMb;
    }
    closeAuthOverlay();
    await refreshNodes();
    connectEvents();
    hub.callbacks?.onAuthSuccess?.();
  }

  window.SummonHub = Object.freeze({
    state: hub,
    init,
    apiPath,
    onlineNodes,
    offlineNodes,
    nodeById,
    nodeLabel,
    switchNode,
    setFilterNode,
    refreshNodes,
    syncActiveSnapshot,
    mixedRooms,
    botsForNode,
    openAuthOverlay,
    closeAuthOverlay,
    applyAuthResult,
    renderNodeFilterBar,
    renderNoOnlineNodesEmpty,
    renderHubSettingsSection,
    loadInvites,
  });
})();
