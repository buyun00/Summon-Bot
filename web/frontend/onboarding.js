(() => {
  'use strict';

  const SUMMON_ROOM_ID = 'room-default-bot-maintenance';
  const LIVE_STATUSES = new Set(['opening', 'running', 'submitted', 'waiting', 'queued', 'needs_input', 'awaiting_input']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PROVIDERS = [
    { id: 'codex', kind: 'codex', name: 'Codex 订阅', subtitle: 'ChatGPT 账号授权', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', defaultModel: 'gpt-6.1-terra' },
    { id: 'grok', kind: 'grok', name: 'Grok 订阅', subtitle: 'Grok 账号授权', provider: 'xai', api: 'openai-responses', baseUrl: 'https://cli-chat-proxy.grok.com/v1', defaultModel: 'grok-4.7' },
    { id: 'deepseek', kind: 'api', name: 'DeepSeek', subtitle: '只需 API Key', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    { id: 'openai', kind: 'api', name: 'OpenAI', subtitle: '只需 API Key', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.4' },
    { id: 'anthropic', kind: 'api', name: 'Anthropic', subtitle: 'Claude API Key', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
    { id: 'openrouter', kind: 'api', name: 'OpenRouter', subtitle: '多模型聚合 Key', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.4' },
    { id: 'openai-compatible', kind: 'api', name: '自定义 API', subtitle: 'Token Plan / 本机', provider: 'openai-compatible', api: 'openai-completions', baseUrl: '', defaultModel: '' },
  ];

  const ob = {
    open: false,
    preview: false,
    stage: 'model', // 'model' | 'bot'
    morphing: false,
    selectedProvider: 'codex',
    userPickedProvider: false,
    localSources: [],
    localLoaded: false,
    localLoading: false,
    catalog: null,
    draft: { name: 'Codex 订阅', baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses', model: 'gpt-6.1-terra', apiKey: '', allowNoKey: false },
    busy: false,
    phase: 'idle',
    statusText: '',
    oauthConnId: null,
    oauthState: null,
    oauthTimer: null,
    // Stage 2: single-step Bot onboarding state
    botId: null,
    botName: '',
    bundledId: null,
    roomId: SUMMON_ROOM_ID,
    wakeMessageId: null,
    botStartedAt: 0,
    botMessages: [],
    botActivities: [],
    botExecutions: [],
    botMilestones: [],
    botExecSeenAt: new Map(),
    botSending: false,
    botPollTimer: null,
    botTickTimer: null,
    botRefreshPending: false,
    callbacks: null,
  };

  if (navigator.platform?.toLowerCase().includes('win')) {
    document.documentElement.classList.add('is-win');
  }

  function providerDef(id) {
    return PROVIDERS.find(item => item.id === id) || PROVIDERS[2];
  }

  function isLocalMode() {
    const hubMode = window.SummonHub?.state?.mode;
    return !hubMode || hubMode === 'local';
  }

  function providerModels(providerId) {
    if (!ob.catalog) return [];
    if (providerId === 'codex') return ob.catalog.codexModels || [];
    const preset = (ob.catalog.presets || []).find(item => item.id === providerId);
    return preset?.models || [];
  }

  function formatElapsed(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function renderSimpleMarkdown(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const blocks = [];
    const withPlaceholders = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
      const idx = blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`) - 1;
      return `\u0000BLOCK_${idx}\u0000`;
    });
    let html = esc(withPlaceholders)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    html = html.replace(/\u0000BLOCK_(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || '');
    return html;
  }

  function stopOAuthPoll() {
    if (ob.oauthTimer) { clearTimeout(ob.oauthTimer); ob.oauthTimer = null; }
  }

  function stopBotWatchers() {
    if (ob.botPollTimer) { clearInterval(ob.botPollTimer); ob.botPollTimer = null; }
    if (ob.botTickTimer) { clearInterval(ob.botTickTimer); ob.botTickTimer = null; }
  }

  function avatarSvg(id = 'bot-default-eggbot-local', size = 60, state = 'idle', { key = null, staticOnly = false } = {}) {
    const avatars = window.SummonAvatars;
    if (avatars?.render) {
      const style = avatars.defaults(id);
      if (staticOnly) {
        return avatars.render(style, size, { identity: id, state, static: true });
      }
      return avatars.render(style, size, { key: key || `onboarding:${id}`, identity: id, preview: true, state });
    }
    return `<img src="/icons/icon-192.png" alt="Summon Bot" width="${size}" height="${size}" style="border-radius:16px">`;
  }

  function renderProviderIcon(item) {
    return window.SummonModelIcons?.svg
      ? window.SummonModelIcons.svg({ kind: item.kind, provider: item.provider, model: item.defaultModel }, 17)
      : '';
  }

  function selectProvider(id, { userInitiated = true } = {}) {
    stopOAuthPoll();
    if (userInitiated) ob.userPickedProvider = true;
    ob.selectedProvider = id;
    const def = providerDef(id);
    const models = providerModels(id);
    ob.draft = {
      name: def.name,
      baseUrl: def.baseUrl,
      api: def.api,
      model: models[0]?.id || def.defaultModel || '',
      apiKey: '',
      allowNoKey: false,
    };
    ob.phase = 'idle';
    ob.statusText = '';
    ob.oauthState = null;
    ob.oauthConnId = null;
    render();
  }

  async function loadCatalogAndLocal({ force = false } = {}) {
    const api = ob.callbacks?.api;
    if (!api || ob.localLoading) return;
    if (ob.localLoaded && !force) return;
    ob.localLoading = true;
    if (force && ob.open && ob.stage === 'model') render();
    try {
      const [catalogRes, localRes] = await Promise.allSettled([
        api('/api/model-settings'),
        api('/api/model-settings/local'),
      ]);
      if (catalogRes.status === 'fulfilled' && catalogRes.value) {
        ob.catalog = catalogRes.value;
      }
      if (localRes.status === 'fulfilled' && Array.isArray(localRes.value?.sources)) {
        ob.localSources = localRes.value.sources.filter(item => item.available);
        ob.localLoaded = true;
        if (!ob.userPickedProvider) {
          const nextId = ob.localSources.some(s => s.kind === 'codex')
            ? 'codex'
            : ob.localSources.some(s => s.kind === 'grok')
              ? 'grok'
              : 'deepseek';
          ob.selectedProvider = nextId;
          const def = providerDef(nextId);
          const models = providerModels(nextId);
          ob.draft = {
            name: def.name,
            baseUrl: def.baseUrl,
            api: def.api,
            model: models[0]?.id || def.defaultModel || '',
            apiKey: '',
            allowNoKey: false,
          };
        }
      }
      const models = providerModels(ob.selectedProvider);
      if (!ob.draft.model && models[0]?.id) ob.draft.model = models[0].id;
    } finally {
      ob.localLoading = false;
      if (ob.open && ob.stage === 'model') render();
    }
  }

  function ensureOverlayElement() {
    let root = document.getElementById('summon-onboarding-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'summon-onboarding-root';
    root.className = 'ob-root';
    root.innerHTML = `<main class="ob-stage" id="ob-stage" role="dialog" aria-modal="true" aria-label="Summon Bot 初始化"></main>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('is-ready'));
    return root;
  }

  function renderModelStage() {
    const def = providerDef(ob.selectedProvider);
    const choices = providerModels(ob.selectedProvider);
    const activeExisting = ob.catalog?.connections?.find(c => c.id === ob.catalog.activeId && c.configured);
    const hasLocalCodex = ob.localSources.some(s => s.kind === 'codex');
    const hasLocalGrok = ob.localSources.some(s => s.kind === 'grok');
    const faceState = ob.phase === 'testing' || ob.phase === 'saving' ? 'work' : 'idle';
    const faceClass = ob.phase === 'testing' || ob.phase === 'saving' ? 'is-testing' : ob.phase === 'success' ? 'is-success' : '';

    const previewActiveBanner = ob.preview && activeExisting
      ? `<div class="ob-preview-existing">
          <span>当前已接入 <strong>${esc(activeExisting.name)}</strong>（${esc(activeExisting.model)}）</span>
          <button type="button" class="ob-primary-btn" data-ob-action="preview-next" ${ob.busy ? 'disabled' : ''}>预览下一步 →</button>
        </div>`
      : '';

    const providerGrid = `<div class="ob-provider-grid" role="tablist" aria-label="选择 AI 服务商">${PROVIDERS.map(item => {
      const detected = (item.id === 'codex' && hasLocalCodex) || (item.id === 'grok' && hasLocalGrok);
      return `
      <button type="button" role="tab" aria-selected="${item.id === ob.selectedProvider}" class="ob-provider-tile ${item.id === ob.selectedProvider ? 'is-selected' : ''} ${detected ? 'has-local' : ''}" data-ob-action="pick-provider" data-provider="${esc(item.id)}" ${ob.busy ? 'disabled' : ''}>
        <span class="ob-provider-head">${renderProviderIcon(item)}<strong>${esc(item.name)}</strong></span>
        <small>${esc(detected ? '已登录 · 直接复用' : item.subtitle)}</small>
      </button>`;
    }).join('')}</div>`;

    let formBody = '';
    if (def.kind === 'codex' || def.kind === 'grok') {
      const hasLocal = def.kind === 'codex' ? hasLocalCodex : hasLocalGrok;
      const subLabel = def.kind === 'codex' ? 'Codex' : 'Grok';
      const waiting = ob.oauthState && ['starting', 'waiting'].includes(ob.oauthState.status);
      if (waiting) {
        formBody = `<div class="ob-oauth-box">
          <small>${ob.oauthState.status === 'starting' ? '正在获取授权信息…' : '请在打开的浏览器页面中完成登录'}</small>
          ${ob.oauthState.userCode ? `<div class="ob-device-code">${esc(ob.oauthState.userCode)}</div>` : ''}
          <div class="ob-oauth-actions">
            ${ob.oauthState.verificationUri ? `<a class="ob-primary-btn" href="${esc(ob.oauthState.verificationUri)}" target="_blank" rel="noopener noreferrer">打开登录页面</a>` : ''}
            <button type="button" class="ob-secondary-btn" data-ob-action="cancel-oauth">取消</button>
          </div>
        </div>`;
      } else if (!ob.localLoaded) {
        formBody = `<div class="ob-oauth-box">
          <small class="ob-detecting"><span class="ob-spinner"></span>正在检测本机 ${subLabel} 登录态…</small>
        </div>`;
      } else if (hasLocal) {
        formBody = `<div class="ob-oauth-box is-detected">
          <div class="ob-oauth-detected-head">
            <strong>检测到本机已有 ${subLabel} 订阅</strong>
            <small>直接复用本机登录态，并自动衔接对接专职 Bot</small>
          </div>
          <div class="ob-oauth-actions">
            <button type="button" class="ob-primary-btn" data-ob-action="import-local" data-kind="${esc(def.kind)}" ${ob.busy ? 'disabled' : ''}>
              ${ob.busy && ob.phase !== 'idle' ? '<span class="ob-spinner"></span>正在接入…' : '复用并继续'}
            </button>
            <button type="button" class="ob-secondary-btn" data-ob-action="start-sub-oauth" data-kind="${esc(def.kind)}" ${ob.busy ? 'disabled' : ''}>改用其他账号</button>
          </div>
        </div>`;
      } else {
        formBody = `<div class="ob-oauth-box">
          <small>未检测到本机 ${subLabel} 登录，你可以登录 ${subLabel} 订阅账号，或在上方改用 DeepSeek / OpenAI / Anthropic / 自定义 API Key。</small>
          <div class="ob-oauth-actions">
            <button type="button" class="ob-primary-btn" data-ob-action="start-sub-oauth" data-kind="${esc(def.kind)}" ${ob.busy ? 'disabled' : ''}>登录 ${subLabel} 订阅</button>
            <button type="button" class="ob-secondary-btn" data-ob-action="redetect-local" ${ob.busy || ob.localLoading ? 'disabled' : ''}>重新检测</button>
          </div>
        </div>`;
      }
    } else {
      const isCustom = def.id === 'openai-compatible';
      const datalistId = 'ob-model-choices';
      formBody = `<form class="ob-form" id="ob-model-form">
        ${isCustom ? `
          <label class="ob-field"><span>API 地址</span><input name="baseUrl" type="url" required value="${esc(ob.draft.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
          <label class="ob-field"><span>接口协议</span><select name="api">
            <option value="openai-completions" ${ob.draft.api === 'openai-completions' ? 'selected' : ''}>OpenAI Chat Completions</option>
            <option value="openai-responses" ${ob.draft.api === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
            <option value="anthropic-messages" ${ob.draft.api === 'anthropic-messages' ? 'selected' : ''}>Anthropic Messages</option>
          </select></label>
        ` : ''}
        <label class="ob-field">
          <span>API Key${isCustom ? '（本机服务无需密钥可勾选下方）' : ''}</span>
          <input name="apiKey" type="password" ${!isCustom || !ob.draft.allowNoKey ? 'required' : ''} value="${esc(ob.draft.apiKey)}" placeholder="粘贴你的 ${esc(def.name)} API Key" autocomplete="new-password" spellcheck="false">
        </label>
        <label class="ob-field">
          <span>默认模型</span>
          <input name="model" list="${datalistId}" required value="${esc(ob.draft.model)}" placeholder="填写或选择模型 ID" autocomplete="off" spellcheck="false">
          <datalist id="${datalistId}">${choices.map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}</datalist>
        </label>
        ${isCustom ? `<label class="ob-checkbox"><input type="checkbox" name="allowNoKey" ${ob.draft.allowNoKey ? 'checked' : ''}>此服务无需 API Key（例如本机 Ollama / LM Studio）</label>` : `
          <details class="ob-advanced">
            <summary>自定义代理地址或协议</summary>
            <div class="ob-advanced-body">
              <label class="ob-field"><span>API 地址</span><input name="baseUrl" type="url" value="${esc(ob.draft.baseUrl)}" placeholder="${esc(def.baseUrl)}"></label>
              <label class="ob-field"><span>接口协议</span><select name="api">
                <option value="openai-completions" ${ob.draft.api === 'openai-completions' ? 'selected' : ''}>OpenAI Chat Completions</option>
                <option value="openai-responses" ${ob.draft.api === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
                <option value="anthropic-messages" ${ob.draft.api === 'anthropic-messages' ? 'selected' : ''}>Anthropic Messages</option>
              </select></label>
            </div>
          </details>
        `}
        <div class="ob-actions">
          <span style="font-size:12px;color:var(--muted)">密钥仅保存在你这台电脑本地</span>
          <button type="submit" class="ob-primary-btn" ${ob.busy ? 'disabled' : ''}>
            ${ob.phase === 'testing' ? '<span class="ob-spinner"></span>正在检测…' : ob.phase === 'saving' ? '<span class="ob-spinner"></span>正在保存…' : '接通并进入'}
          </button>
        </div>
      </form>`;
    }

    const statusBar = ob.statusText
      ? `<div class="ob-status ${ob.phase === 'success' ? 'is-ok' : ob.phase === 'error' ? 'is-error' : 'is-info'}" role="status">
          ${ob.phase === 'testing' || ob.phase === 'saving' || ob.phase === 'oauth' ? '<span class="ob-spinner"></span>' : ''}
          <span>${esc(ob.statusText)}</span>
        </div>`
      : '';

    return `
      <div class="ob-window-bar">
        <span class="ob-window-brand">Summon Bot <span class="ob-step-dots"><span class="ob-step-dot is-active"></span><span class="ob-step-dot"></span></span></span>
        <div class="ob-window-controls">${ob.preview ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-preview">退出预览</button>' : ''}</div>
      </div>
      <div class="ob-model-scroll">
        <header class="ob-hero">
          <div class="ob-hero-face ${faceClass}">${avatarSvg('bot-default-eggbot-local', 60, faceState)}</div>
          <h1>点亮你的第一个 AI</h1>
          <p>选择本机订阅或任意模型 API，接通后即可直接建群开工。</p>
        </header>
        ${previewActiveBanner}
        ${providerGrid}
        ${formBody}
        ${statusBar}
      </div>
    `;
  }

  function formatClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function isAutoWakeMessage(msg) {
    if (!msg) return false;
    if (ob.wakeMessageId && msg.id === ob.wakeMessageId) return true;
    const sender = msg.senderId || msg.author?.id;
    const text = String(msg.content || '').trim();
    return sender === 'user' && /^@[^\s]+\s+请在后台自检本机环境/.test(text);
  }

  function botStageSnapshot() {
    const botId = ob.botId;
    const wakeMsg = ob.botMessages.find(isAutoWakeMessage) || null;
    if (wakeMsg && !ob.wakeMessageId) ob.wakeMessageId = wakeMsg.id;
    const wakeIdx = wakeMsg ? ob.botMessages.indexOf(wakeMsg) : -1;
    const relevant = (wakeIdx >= 0 ? ob.botMessages.slice(wakeIdx + 1) : ob.botMessages)
      .filter(m => {
        if (isAutoWakeMessage(m)) return false;
        const sender = m.senderId || m.author?.id;
        return !botId || sender === botId || sender === 'user';
      });
    const botSessions = (ob.botExecutions || []).filter(e =>
      e.kind === 'session' && (!botId || (e.execution_actor?.id || e.bot_id) === botId)
    );
    const activeActivity = (ob.botActivities || []).find(a => !botId || a.bot_id === botId);
    const liveExec = botSessions.find(e => LIVE_STATUSES.has(e.status)) || null;
    const pendingExec = liveExec && ['needs_input', 'awaiting_input'].includes(liveExec.status) ? liveExec : null;
    const pendingPromptMsg = [...relevant].reverse().find(m => m.prompt && !m.prompt_response);
    const hasBotReply = relevant.some(m => (m.senderId || m.author?.id) === botId && (m.content || '').trim());
    const hasAck = Boolean(
      wakeMsg?.acks?.some(a => !botId || a.botId === botId) ||
      botSessions.length ||
      activeActivity ||
      hasBotReply
    );
    const ackAt = wakeMsg?.acks?.find(a => !botId || a.botId === botId)?.at || null;
    const isWorking = Boolean(activeActivity || (liveExec && !pendingExec));
    const isReady = hasBotReply && !isWorking && !pendingExec && !pendingPromptMsg;
    const lastBotMsg = [...relevant].reverse().find(m => (m.senderId || m.author?.id) === botId && (m.content || '').trim());
    const lastBotText = String(lastBotMsg?.content || '');
    const hasFailedExec = botSessions.some(e => ['failed', 'error'].includes(e.status));
    const replyReportsIssue = /(?:暂不能认定|未就绪|无法就绪|自检失败|未能通过|未安装|未登录|报错|无法启动|退出码为\s*[1-9])/.test(lastBotText);
    const hasError = isReady && (hasFailedExec || replyReportsIssue);
    const progressText = pendingExec
      ? (pendingExec.pending_requests?.[0]?.question || '等待你的确认或输入')
      : (activeActivity?.text || liveExec?.live_progress || liveExec?.work_summary || (hasAck ? '正在分析环境与执行自检…' : '正在唤醒专职 Bot…'));
    return { wakeMsg, relevant, botSessions, activeActivity, liveExec, pendingExec, pendingPromptMsg, hasBotReply, hasAck, ackAt, isWorking, isReady, hasError, progressText };
  }

  function recordBotProgressSnapshot() {
    const botId = ob.botId;
    const now = Date.now();
    const wakeMsg = ob.botMessages.find(isAutoWakeMessage);
    const baseTs = wakeMsg?.createdAt ? Date.parse(wakeMsg.createdAt) : (ob.botStartedAt || now);
    if (wakeMsg?.createdAt && Number.isFinite(baseTs)) {
      ob.botStartedAt = baseTs;
    }
    const sessions = (ob.botExecutions || []).filter(e =>
      e.kind === 'session' && (!botId || (e.execution_actor?.id || e.bot_id) === botId)
    );
    sessions.forEach((exec, idx) => {
      if (!exec.id || ob.botExecSeenAt.has(exec.id)) return;
      const parsed = Date.parse(exec.started_at || exec.created_at || '');
      if (Number.isFinite(parsed)) {
        ob.botExecSeenAt.set(exec.id, parsed);
      } else if (!LIVE_STATUSES.has(exec.status)) {
        // Already completed before first poll (e.g. after reload): place right after wake, before final reply
        ob.botExecSeenAt.set(exec.id, baseTs + 1000 + idx * 1000);
      } else {
        ob.botExecSeenAt.set(exec.id, now + idx);
      }
    });
    const execSummaries = new Set(
      sessions.map(e => String(e.work_summary || '').trim()).filter(Boolean)
    );
    for (const act of (ob.botActivities || [])) {
      if (botId && act.bot_id && act.bot_id !== botId) continue;
      const text = String(act.text || '').trim();
      if (!text || execSummaries.has(text)) continue;
      const last = ob.botMilestones.at(-1);
      if (!last || last.text !== text) {
        ob.botMilestones.push({ id: `ms-${ob.botMilestones.length + 1}`, text, time: now });
      }
    }
  }

  function buildBotFeedItems(snap, label, avatarId) {
    const items = [];
    const makeBotAvatar = () => avatarSvg(avatarId, 28, 'idle', { staticOnly: true });
    const startedTs = snap.wakeMsg?.createdAt ? Date.parse(snap.wakeMsg.createdAt) : (ob.botStartedAt || Date.now());
    const startedClock = formatClock(startedTs);

    // 1. Friendly kickoff bubble on the user side
    items.push({
      key: 'kickoff',
      sig: `kickoff:${label}:${startedClock}`,
      html: `<div class="ob-chat-row is-user">
        <div class="ob-chat-col">
          <div class="ob-chat-meta"><span>你</span><span>${esc(startedClock)}</span></div>
          <div class="ob-bubble is-user">开始对接本机 <strong>${esc(label)}</strong> 并执行环境自检</div>
        </div>
      </div>`,
    });

    // 2. Immediate Bot acknowledgement bubble once Bot wakes / acks
    if (snap.hasAck) {
      const ackTime = snap.ackAt || startedTs;
      const ackClock = formatClock(ackTime);
      items.push({
        key: 'ack',
        sig: `ack:${label}:${ackClock}`,
        html: `<div class="ob-chat-row is-bot">
          <div class="ob-chat-avatar">${makeBotAvatar()}</div>
          <div class="ob-chat-col">
            <div class="ob-chat-meta"><strong>${esc(label)}</strong><span>${esc(ackClock)}</span></div>
            <div class="ob-bubble is-bot">收到，开始检查本机环境与登录状态。</div>
          </div>
        </div>`,
      });
    }

    // 3. Chronological stream of exec step bubbles, activity milestones, and room messages
    const timeline = [];
    for (const exec of snap.botSessions) {
      const ts = ob.botExecSeenAt.get(exec.id) || Date.parse(exec.started_at || exec.created_at || '') || startedTs + 1;
      timeline.push({ kind: 'exec', ts, id: exec.id, data: exec });
    }
    for (const ms of ob.botMilestones) {
      timeline.push({ kind: 'milestone', ts: ms.time, id: ms.id, data: ms });
    }
    for (const msg of snap.relevant) {
      const ts = Date.parse(msg.createdAt || '') || Date.now();
      timeline.push({ kind: 'msg', ts, id: msg.id, data: msg });
    }
    timeline.sort((a, b) => a.ts - b.ts);

    for (const entry of timeline) {
      if (entry.kind === 'exec') {
        const exec = entry.data;
        const isLive = LIVE_STATUSES.has(exec.status);
        const isNeedsInput = ['needs_input', 'awaiting_input'].includes(exec.status);
        const isFailed = ['failed', 'error', 'cancelled', 'stopped'].includes(exec.status);
        const stateLabel = isNeedsInput ? '等待确认' : isLive ? '执行中' : isFailed ? '异常' : '已完成';
        const stateClass = isNeedsInput ? 'is-warn' : isLive ? 'is-live' : isFailed ? 'is-err' : 'is-done';
        const title = exec.work_summary || '执行本机自检任务';
        const detail = isLive && exec.live_progress && exec.live_progress !== title ? exec.live_progress : '';
        const reqs = isNeedsInput && exec.pending_requests?.length ? exec.pending_requests : [];
        const clock = formatClock(entry.ts);
        const sig = `exec:${exec.id}:${exec.status}:${title}:${detail}:${reqs.length}:${clock}`;
        items.push({
          key: `exec:${exec.id}`,
          sig,
          html: `<div class="ob-chat-row is-bot">
            <div class="ob-chat-avatar">${makeBotAvatar()}</div>
            <div class="ob-chat-col">
              <div class="ob-chat-meta"><strong>${esc(label)}</strong><span>${esc(clock)}</span></div>
              <div class="ob-step-bubble ${stateClass}">
                <div class="ob-step-head">
                  <span class="ob-step-pill ${stateClass}">
                    ${isLive && !isNeedsInput ? '<span class="ob-spinner"></span>' : isFailed ? '!' : isNeedsInput ? '?' : '✓'}
                    ${esc(stateLabel)}
                  </span>
                  <span class="ob-step-title">${esc(title)}</span>
                </div>
                ${detail ? `<div class="ob-step-detail">${esc(detail)}</div>` : ''}
                ${reqs.map(req => `
                  <div class="ob-step-prompt">
                    ${req.question ? `<div>${esc(req.question)}</div>` : ''}
                    ${req.choices?.length ? `<div class="ob-prompt-choices">${req.choices.map(c => `
                      <button type="button" class="ob-secondary-btn" data-ob-action="reply-exec-req" data-exec-id="${esc(exec.execution_ref?.id || exec.id)}" data-req-id="${esc(req.request_id || '')}" data-val="${esc(c.id)}">${esc(c.label || c.id)}</button>`).join('')}</div>` : ''}
                    ${req.plain_text ? `<form class="ob-inline-reply" data-ob-exec-reply="${esc(exec.execution_ref?.id || exec.id)}" data-req-id="${esc(req.request_id || '')}">
                      <input name="val" type="text" placeholder="输入回复…" autocomplete="off">
                      <button type="submit" class="ob-primary-btn">提交</button>
                    </form>` : ''}
                  </div>`).join('')}
              </div>
            </div>
          </div>`,
        });
        continue;
      }

      if (entry.kind === 'milestone') {
        const ms = entry.data;
        const isCurrent = !snap.isReady && snap.activeActivity?.text === ms.text;
        const clock = formatClock(entry.ts);
        const sig = `ms:${ms.id}:${isCurrent ? 'live' : 'done'}:${ms.text}:${clock}`;
        items.push({
          key: `ms:${ms.id}`,
          sig,
          html: `<div class="ob-chat-row is-bot">
            <div class="ob-chat-avatar">${makeBotAvatar()}</div>
            <div class="ob-chat-col">
              <div class="ob-chat-meta"><strong>${esc(label)}</strong><span>${esc(clock)}</span></div>
              <div class="ob-step-bubble ${isCurrent ? 'is-live' : 'is-done'}">
                <div class="ob-step-head">
                  <span class="ob-step-pill ${isCurrent ? 'is-live' : 'is-done'}">${isCurrent ? '<span class="ob-spinner"></span>进展' : '✓ 已完成'}</span>
                  <span class="ob-step-title">${esc(ms.text)}</span>
                </div>
              </div>
            </div>
          </div>`,
        });
        continue;
      }

      if (entry.kind === 'msg') {
        const msg = entry.data;
        const isUser = (msg.senderId || msg.author?.id) === 'user';
        const bodyHtml = renderSimpleMarkdown(msg.content);
        const hasPendingPrompt = Boolean(msg.prompt && !msg.prompt_response);
        if (!bodyHtml && !hasPendingPrompt) continue;
        let promptHtml = '';
        if (hasPendingPrompt) {
          const p = msg.prompt;
          if (p.kind === 'secret') {
            promptHtml = `<div class="ob-prompt-card">
              <strong>${esc(p.title || '需要安全录入凭据')}</strong>
              ${p.description ? `<div style="font-size:12.5px;color:var(--muted)">${esc(p.description)}</div>` : ''}
              <div><button type="button" class="ob-primary-btn" data-ob-action="open-secret-prompt" data-msg-id="${esc(msg.id)}">${esc(p.submit_label || '打开隐私输入窗')}</button></div>
            </div>`;
          } else {
            const q = p.questions?.[0];
            const opts = q?.options || [];
            promptHtml = `<div class="ob-prompt-card">
              <strong>${esc(p.title || q?.label || '请确认')}</strong>
              ${opts.length ? `<div class="ob-prompt-choices">${opts.map(opt => `
                <button type="button" class="ob-secondary-btn" data-ob-action="reply-prompt-opt" data-msg-id="${esc(msg.id)}" data-label="${esc(opt.label)}">${esc(opt.label)}</button>`).join('')}</div>` : ''}
            </div>`;
          }
        }
        const clock = formatClock(entry.ts);
        const sig = `msg:${msg.id}:${msg.content || ''}:${hasPendingPrompt ? 'p1' : 'p0'}:${clock}`;
        items.push({
          key: `msg:${msg.id}`,
          sig,
          html: `<div class="ob-chat-row ${isUser ? 'is-user' : 'is-bot'}">
            ${isUser ? '' : `<div class="ob-chat-avatar">${makeBotAvatar()}</div>`}
            <div class="ob-chat-col">
              <div class="ob-chat-meta"><strong>${esc(isUser ? '你' : label)}</strong><span>${esc(clock)}</span></div>
              ${bodyHtml ? `<div class="ob-bubble ${isUser ? 'is-user' : 'is-bot'}">${bodyHtml}</div>` : ''}
              ${promptHtml}
            </div>
          </div>`,
        });
      }
    }

    // 4. Final prominent Bot CTA bubble when docking completes (or clear error + retry card if abnormal!)
    if (snap.isReady) {
      const doneClock = formatClock(Date.now());
      if (snap.hasError) {
        items.push({
          key: 'final-cta',
          sig: `final-err:${label}:${ob.botSending ? '1' : '0'}`,
          html: `<div class="ob-chat-row is-bot">
            <div class="ob-chat-avatar">${makeBotAvatar()}</div>
            <div class="ob-chat-col ob-chat-col-wide">
              <div class="ob-chat-meta"><strong>${esc(label)}</strong><span>${esc(doneClock)}</span></div>
              <div class="ob-final-cta-bubble is-error">
                <div class="ob-final-cta-copy">
                  <strong>自检发现异常，尚未完全就绪</strong>
                  <p>请根据上方提示处理后重新自检，也可以稍后在工作台内继续排查。</p>
                </div>
                <div class="ob-final-cta-actions">
                  <button type="button" class="ob-hero-cta-btn" data-ob-action="retry-bot-check" ${ob.botSending ? 'disabled' : ''}>
                    ${ob.botSending ? '<span class="ob-spinner"></span>正在重新发起自检…' : '重新自检'}
                  </button>
                  <button type="button" class="ob-text-link-btn" data-ob-action="finish-to-main">稍后处理，先进入工作台</button>
                </div>
              </div>
            </div>
          </div>`,
        });
      } else {
        items.push({
          key: 'final-cta',
          sig: `final-ok:${label}`,
          html: `<div class="ob-chat-row is-bot">
            <div class="ob-chat-avatar">${makeBotAvatar()}</div>
            <div class="ob-chat-col ob-chat-col-wide">
              <div class="ob-chat-meta"><strong>${esc(label)}</strong><span>${esc(doneClock)}</span></div>
              <div class="ob-final-cta-bubble">
                <div class="ob-final-cta-copy">
                  <strong>一切就绪，随时可以开工！</strong>
                  <p>点下方按钮展开完整工作台，立刻创建你的第一个群聊。</p>
                </div>
                <button type="button" class="ob-hero-cta-btn" data-ob-action="finish-to-main">进入工作台，开始建群 →</button>
              </div>
            </div>
          </div>`,
        });
      }
    }

    return items;
  }

  function mountBotStage(stage) {
    const label = ob.botName || (ob.bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
    const avatarId = ob.botId || 'bot-default-eggbot-local';
    stage.dataset.mountedStage = 'bot';
    stage.innerHTML = `
      <div class="ob-window-bar">
        <span class="ob-window-brand"><span data-ob-brand-text>Summon Bot · 接入 ${esc(label)}</span> <span class="ob-step-dots"><span class="ob-step-dot is-done"></span><span class="ob-step-dot is-active"></span></span></span>
        <div class="ob-window-controls">
          ${ob.preview ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-preview">退出预览</button>' : ''}
        </div>
      </div>
      <div class="ob-bot-shell">
        <div class="ob-bot-header">
          <div class="ob-bot-identity">
            <div data-ob-bot-avatar>${avatarSvg(avatarId, 44, 'work', { key: `ob-header:${avatarId}` })}</div>
            <div class="ob-bot-titles">
              <h2 data-ob-bot-title>正在对接 ${esc(label)}</h2>
              <p data-ob-bot-subtitle>自动检测本机环境与登录状态，完成后即可建群开工</p>
            </div>
          </div>
          <span class="ob-bot-badge is-live" data-ob-badge>
            <span class="ob-live-dot" data-ob-live-dot></span>
            <span data-ob-badge-text>对接中 00:00</span>
          </span>
        </div>
        <div class="ob-bot-feed" id="ob-bot-feed"></div>
        <div class="ob-bot-live-bar" data-ob-live-bar>
          <span class="ob-bot-live-left">
            <span class="ob-spinner" style="color:var(--accent,#7d824b)"></span>
            <span class="ob-bot-live-text" data-ob-live-text>正在唤醒专职 Bot…</span>
          </span>
          <span class="ob-bot-timer" data-ob-live-timer>00:00</span>
        </div>
      </div>
    `;
    window.SummonAvatars?.hydrate?.(stage);
  }

  function patchBotStage(stage) {
    if (stage.dataset.mountedStage !== 'bot') {
      mountBotStage(stage);
    }
    const snap = botStageSnapshot();
    const label = ob.botName || (ob.bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
    const avatarId = ob.botId || 'bot-default-eggbot-local';
    const elapsed = formatElapsed(Date.now() - (ob.botStartedAt || Date.now()));

    const brandEl = stage.querySelector('[data-ob-brand-text]');
    const nextBrand = `Summon Bot · 接入 ${label}`;
    if (brandEl && brandEl.textContent !== nextBrand) brandEl.textContent = nextBrand;

    const titleEl = stage.querySelector('[data-ob-bot-title]');
    const nextTitle = snap.hasError ? `${label} 自检异常` : snap.isReady ? `${label} 已就绪` : `正在对接 ${label}`;
    if (titleEl && titleEl.textContent !== nextTitle) titleEl.textContent = nextTitle;

    const subEl = stage.querySelector('[data-ob-bot-subtitle]');
    const nextSub = snap.hasError
      ? '自检过程中发现问题，请查看下方报错并重试'
      : snap.isReady
        ? '本机环境与接入验证已全部通过，可以直接建群开始工作'
        : '自动检测本机环境与登录状态，完成后即可建群开工';
    if (subEl && subEl.textContent !== nextSub) subEl.textContent = nextSub;

    const avatarWrap = stage.querySelector('[data-ob-bot-avatar]');
    const avatarState = snap.hasError ? 'failed' : snap.isWorking ? 'work' : snap.isReady ? 'done' : 'idle';
    const avatarKey = `${avatarId}:${avatarState}`;
    if (avatarWrap && avatarWrap.dataset.avatarKey !== avatarKey) {
      avatarWrap.dataset.avatarKey = avatarKey;
      avatarWrap.innerHTML = avatarSvg(avatarId, 44, avatarState, { key: `ob-header:${avatarId}` });
      window.SummonAvatars?.hydrate?.(avatarWrap);
    }

    const badgeEl = stage.querySelector('[data-ob-badge]');
    const badgeDot = stage.querySelector('[data-ob-live-dot]');
    const badgeTextEl = stage.querySelector('[data-ob-badge-text]');
    const nextBadgeText = snap.hasError
      ? '自检异常'
      : snap.isReady
        ? '已就绪 ✓'
        : snap.pendingExec || snap.pendingPromptMsg
          ? '需要你确认'
          : `对接中 ${elapsed}`;
    if (badgeEl) {
      badgeEl.classList.toggle('is-err', snap.hasError);
      badgeEl.classList.toggle('is-done', snap.isReady && !snap.hasError);
      badgeEl.classList.toggle('is-live', !snap.isReady);
    }
    if (badgeDot) badgeDot.hidden = snap.isReady;
    if (badgeTextEl && badgeTextEl.textContent !== nextBadgeText) badgeTextEl.textContent = nextBadgeText;

    const liveBar = stage.querySelector('[data-ob-live-bar]');
    const liveTextEl = stage.querySelector('[data-ob-live-text]');
    const liveTimerEl = stage.querySelector('[data-ob-live-timer]');
    const showLiveBar = !snap.isReady && !snap.pendingExec && !snap.pendingPromptMsg;
    if (liveBar) liveBar.hidden = !showLiveBar;
    if (liveTextEl && liveTextEl.textContent !== snap.progressText) liveTextEl.textContent = snap.progressText;
    if (liveTimerEl && liveTimerEl.textContent !== elapsed) liveTimerEl.textContent = elapsed;

    // Incremental diff of #ob-bot-feed so existing bubbles NEVER flicker or re-animate!
    const feed = stage.querySelector('#ob-bot-feed');
    if (!feed) return;
    const wasNearBottom = (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 60;
    const nextItems = buildBotFeedItems(snap, label, avatarId);
    const nextKeySet = new Set(nextItems.map(item => item.key));
    const existingByKey = new Map();
    for (const child of [...feed.children]) {
      const key = child.dataset.feedKey;
      if (!key || !nextKeySet.has(key)) {
        child.remove();
      } else {
        existingByKey.set(key, child);
      }
    }

    let appended = false;
    nextItems.forEach((item, idx) => {
      let node = existingByKey.get(item.key);
      if (!node) {
        node = document.createElement('div');
        node.className = 'ob-feed-item is-enter';
        node.dataset.feedKey = item.key;
        node.dataset.feedSig = item.sig;
        node.innerHTML = item.html;
        appended = true;
      } else if (node.dataset.feedSig !== item.sig) {
        node.dataset.feedSig = item.sig;
        node.classList.remove('is-enter');
        node.innerHTML = item.html;
      }
      const currentAtIdx = feed.children[idx];
      if (currentAtIdx !== node) {
        feed.insertBefore(node, currentAtIdx || null);
      }
    });

    if (appended || wasNearBottom) {
      feed.scrollTop = feed.scrollHeight;
    }
  }

  function render() {
    const root = document.getElementById('summon-onboarding-root');
    if (!root) return;
    const stage = root.querySelector('#ob-stage');
    if (!stage) return;
    root.classList.toggle('is-stage-bot', ob.stage === 'bot');
    if (ob.stage === 'bot') {
      patchBotStage(stage);
      return;
    }
    stage.dataset.mountedStage = 'model';
    stage.innerHTML = renderModelStage();
    window.SummonAvatars?.hydrate?.(stage);
  }

  async function pollBotStage() {
    if (!ob.open || ob.stage !== 'bot' || ob.preview || ob.botRefreshPending) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.botRefreshPending = true;
    try {
      const [roomRes, execRes] = await Promise.all([
        api(`/api/rooms/${encodeURIComponent(ob.roomId)}/messages`).catch(() => null),
        api(`/api/executions?room=${encodeURIComponent(ob.roomId)}`).catch(() => null),
      ]);
      if (!ob.open || ob.stage !== 'bot') return;
      if (roomRes) {
        ob.botMessages = roomRes.messages || [];
        ob.botActivities = roomRes.activities || [];
      }
      if (execRes) {
        ob.botExecutions = execRes.items || [];
      }
      recordBotProgressSnapshot();
      render();
    } finally {
      ob.botRefreshPending = false;
    }
  }

  function startBotWatchers() {
    stopBotWatchers();
    void pollBotStage();
    ob.botPollTimer = setInterval(() => void pollBotStage(), 1800);
    ob.botTickTimer = setInterval(() => {
      if (!ob.open || ob.stage !== 'bot') return;
      const elapsed = formatElapsed(Date.now() - (ob.botStartedAt || Date.now()));
      const snap = botStageSnapshot();
      const badgeEl = document.querySelector('[data-ob-badge-text]');
      if (badgeEl && !snap.isReady && !snap.pendingExec && !snap.pendingPromptMsg) {
        badgeEl.textContent = `对接中 ${elapsed}`;
      }
      const timerEl = document.querySelector('[data-ob-live-timer]');
      if (timerEl && !snap.isReady) {
        timerEl.textContent = elapsed;
      }
    }, 1000);
  }

  async function morphToBotStage({ botId, botName, bundledId, roomId, wakeMessageId, preview = false }) {
    ob.stage = 'bot';
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    ob.botId = botId || null;
    ob.botName = botName || (bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
    ob.bundledId = bundledId || 'codex';
    ob.roomId = roomId || SUMMON_ROOM_ID;
    ob.wakeMessageId = wakeMessageId || null;
    ob.botStartedAt = Date.now();
    ob.botMilestones = [];
    ob.botExecSeenAt = new Map();
    ob.botMessages = preview
      ? [{ id: 'preview-reply', senderId: ob.botId || 'preview-codex', createdAt: new Date().toISOString(), content: '**自检完成**\n- Codex CLI 已就绪\n- 本机登录态与 `scripts/app-server.mjs` 桥接验证通过\n\n随时可以建群开始干活。' }]
      : [];
    ob.botActivities = [];
    ob.botExecutions = preview
      ? [
          { kind: 'session', id: 'preview-exec-1', bot_id: 'preview-codex', status: 'completed', work_summary: '检查本机 Codex CLI 与 ChatGPT 登录态' },
          { kind: 'session', id: 'preview-exec-2', bot_id: 'preview-codex', status: 'completed', work_summary: '验证桥接脚本 scripts/app-server.mjs 端到端响应' },
        ]
      : [];
    const stageEl = document.querySelector('#ob-stage');
    if (stageEl) delete stageEl.dataset.mountedStage;
    if (window.SummonDesktop && !preview) {
      try { history.replaceState(null, '', '/?onboarding_window=bot'); } catch {}
    }
    render();
    void window.SummonDesktop?.morphWindow?.('bot', { duration: 400 });
    if (!preview) startBotWatchers();
  }

  async function transitionToMainNewGroup({ preview = false } = {}) {
    if (ob.morphing) return;
    ob.morphing = true;
    stopOAuthPoll();
    stopBotWatchers();
    const api = ob.callbacks?.api;
    if (!preview && api) {
      await api('/api/onboarding/finish', 'POST', {}).catch(() => {});
    }
    // Prepare the New Group Draft screen underneath BEFORE fading out overlay so reveal is instant & 0-flash!
    await ob.callbacks?.onEnterNewGroup?.({ preview });
    document.documentElement.classList.remove('desktop-onboarding-window');
    document.body.classList.add('ob-revealing-main');
    if (location.search.includes('onboarding_window')) {
      try { history.replaceState(null, '', '/'); } catch {}
    }

    const root = document.getElementById('summon-onboarding-root');
    const morphPromise = window.SummonDesktop?.morphWindow?.('main', { duration: 440 }) || Promise.resolve();
    if (root) {
      requestAnimationFrame(() => root.classList.add('is-morphing-to-main'));
    }
    await Promise.all([morphPromise, new Promise(r => setTimeout(r, 380))]);
    root?.remove();
    ob.open = false;
    ob.preview = false;
    ob.stage = 'model';
    ob.busy = false;
    ob.morphing = false;
    setTimeout(() => document.body.classList.remove('ob-revealing-main'), 480);
  }

  async function verifyAndContinue(connId, label, { activateBundled = null } = {}) {
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'testing';
    ob.statusText = `正在测试「${label || '模型'}」连通性…`;
    render();
    try {
      const test = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/test`, 'POST', {});
      ob.phase = 'success';
      ob.statusText = `连接成功 · ${test.model}（${test.latencyMs}ms）`;
      render();
      if (ob.preview) {
        await new Promise(r => setTimeout(r, 320));
        if (activateBundled) {
          await morphToBotStage({ botId: 'preview-codex', botName: activateBundled === 'grok-build' ? 'Grok Build' : 'Codex', bundledId: activateBundled, preview: true });
        } else {
          await transitionToMainNewGroup({ preview: true });
        }
        return;
      }
      // Atomically activate model + start onboarding in a single request so SSE never transiently sees status='completed'.
      const started = await api('/api/onboarding/start', 'POST', {
        connectionId: connId,
        ...(activateBundled ? { activateBundled } : {}),
      });
      if (started?.status === 'configuring_bot' && started.botId) {
        await morphToBotStage({
          botId: started.botId,
          botName: started.botName || started.activatedBot?.name,
          bundledId: started.bundledId || activateBundled,
          roomId: started.roomId || SUMMON_ROOM_ID,
          wakeMessageId: started.wakeMessageId || null,
        });
      } else {
        await transitionToMainNewGroup({ preview: false });
      }
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型连通性检测未通过，请检查配置后重试。';
      render();
    }
  }

  async function handleImportLocal(kind) {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'saving';
    ob.statusText = `正在导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅…`;
    render();
    try {
      const res = await api('/api/model-settings/local/import', 'POST', { kind, activate: false });
      const connId = res.importedId || `${kind}-local`;
      const activateBundled = kind === 'codex' ? 'codex' : kind === 'grok' ? 'grok-build' : null;
      await verifyAndContinue(connId, `本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅`, { activateBundled });
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '导入本机登录失败';
      render();
    }
  }

  async function handleStartSubOAuth(kind = 'codex') {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    const subLabel = kind === 'grok' ? 'Grok' : 'Codex';
    const defaultModel = kind === 'grok' ? 'grok-4.7' : 'gpt-6.1-terra';
    ob.busy = true;
    ob.phase = 'oauth';
    ob.statusText = `正在创建 ${subLabel} 订阅连接并获取授权码…`;
    render();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind, name: `${subLabel} 订阅`, model: ob.draft.model || defaultModel,
      });
      const connId = saved.savedId || saved.connections?.find(c => c.kind === kind && c.authMode !== `${kind}-local`)?.id;
      if (!connId) throw new Error(`未能创建 ${subLabel} 订阅连接`);
      ob.oauthConnId = connId;
      ob.oauthState = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`, 'POST', {});
      ob.busy = false;
      ob.statusText = '请在浏览器中完成授权，授权完成后将自动衔接下一步…';
      render();
      void pollSubOAuth(connId, kind);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || `无法发起 ${subLabel} 授权`;
      render();
    }
  }

  async function pollSubOAuth(connId, kind = 'codex') {
    stopOAuthPoll();
    const api = ob.callbacks?.api;
    if (!api || !ob.open || ob.oauthConnId !== connId) return;
    const subLabel = kind === 'grok' ? 'Grok' : 'Codex';
    try {
      const status = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`);
      ob.oauthState = status;
      if (['starting', 'waiting'].includes(status.status)) {
        render();
        ob.oauthTimer = setTimeout(() => void pollSubOAuth(connId, kind), 2000);
        return;
      }
      if (status.status === 'completed') {
        const activateBundled = kind === 'codex' ? 'codex' : kind === 'grok' ? 'grok-build' : null;
        await verifyAndContinue(connId, `${subLabel} 订阅`, { activateBundled });
        return;
      }
      ob.phase = status.status === 'failed' ? 'error' : 'idle';
      ob.statusText = status.status === 'failed' ? (status.error || `${subLabel} 授权未完成，请重试。`) : '';
      render();
    } catch (error) {
      ob.phase = 'error';
      ob.statusText = error.message || '读取授权状态失败';
      render();
    }
  }

  async function handleCancelOAuth() {
    stopOAuthPoll();
    const api = ob.callbacks?.api;
    if (api && ob.oauthConnId) {
      await api(`/api/model-settings/connections/${encodeURIComponent(ob.oauthConnId)}/login`, 'DELETE', {}).catch(() => {});
    }
    ob.oauthConnId = null;
    ob.oauthState = null;
    ob.phase = 'idle';
    ob.statusText = '';
    render();
  }

  async function handleModelSubmit(form) {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    const def = providerDef(ob.selectedProvider);
    const fd = new FormData(form);
    const baseUrl = String(fd.get('baseUrl') || ob.draft.baseUrl || def.baseUrl || '').trim();
    const apiProto = String(fd.get('api') || ob.draft.api || def.api || 'openai-completions').trim();
    const model = String(fd.get('model') || '').trim();
    const apiKey = String(fd.get('apiKey') || '').trim();
    const allowNoKey = form.elements.allowNoKey?.checked === true;
    ob.draft = { ...ob.draft, baseUrl, api: apiProto, model, apiKey, allowNoKey };

    ob.busy = true;
    ob.phase = 'saving';
    ob.statusText = '正在保存模型配置…';
    render();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind: 'api',
        name: def.id === 'openai-compatible' ? (model || '自定义 API') : def.name,
        provider: def.provider, api: apiProto, baseUrl, model, apiKey, allowNoKey, activate: false,
      });
      const connId = saved.savedId || saved.activeId || saved.connections?.at(-1)?.id;
      if (!connId) throw new Error('未能保存模型配置');
      await verifyAndContinue(connId, def.name);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型配置保存失败';
      render();
    }
  }

  async function sendBotReply(text) {
    const clean = String(text || '').trim();
    if (!clean || ob.botSending) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.botSending = true;
    render();
    try {
      await api(`/api/rooms/${encodeURIComponent(ob.roomId)}/messages`, 'POST', {
        text: clean,
        ...(ob.botId ? { mentions: [{ kind: 'bot', id: ob.botId }] } : {}),
      });
      const input = document.querySelector('#ob-bot-reply-form input[name=text]');
      if (input) input.value = '';
      await pollBotStage();
    } catch (error) {
      ob.callbacks?.toast?.(error.message || '发送失败', true);
    } finally {
      ob.botSending = false;
      render();
    }
  }

  async function openOverlay({ stage = 'model', preview = false, onboarding = null } = {}) {
    if (ob.open && ob.stage === stage && ob.preview === preview) return;
    ob.open = true;
    ob.preview = preview;
    ob.stage = stage;
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    ob.localLoaded = false;
    ob.userPickedProvider = false;
    if (window.SummonDesktop) {
      document.documentElement.classList.add('desktop-onboarding-window');
    }
    ensureOverlayElement();
    if (stage === 'bot') {
      await morphToBotStage({
        botId: onboarding?.botId || ob.botId,
        botName: onboarding?.botName || ob.botName,
        bundledId: onboarding?.bundledId || ob.bundledId,
        roomId: onboarding?.roomId || SUMMON_ROOM_ID,
        wakeMessageId: onboarding?.wakeMessageId || null,
        preview,
      });
      return;
    }
    render();
    await loadCatalogAndLocal({ force: true });
  }

  async function closePreview() {
    if (!ob.preview) return;
    await transitionToMainNewGroup({ preview: true });
  }

  function syncState(onboarding) {
    if (!isLocalMode()) {
      if (ob.open && !ob.preview) {
        stopOAuthPoll();
        stopBotWatchers();
        document.getElementById('summon-onboarding-root')?.remove();
        document.documentElement.classList.remove('desktop-onboarding-window');
        ob.open = false;
      }
      return;
    }
    if (ob.preview || ob.morphing || ob.busy || !onboarding) return;
    if (onboarding.status === 'awaiting_model' && !onboarding.hasActiveModel) {
      if (!ob.open || ob.stage !== 'model') {
        void openOverlay({ stage: 'model', preview: false, onboarding });
      } else if (!ob.localLoaded && !ob.localLoading) {
        void loadCatalogAndLocal();
      }
      return;
    }
    if (onboarding.status === 'configuring_bot') {
      if (!ob.open || ob.stage !== 'bot') {
        void openOverlay({ stage: 'bot', preview: false, onboarding });
      } else {
        const prevBotId = ob.botId;
        const prevWakeId = ob.wakeMessageId;
        if (onboarding.botId && !ob.botId) ob.botId = onboarding.botId;
        if (onboarding.botName && !ob.botName) ob.botName = onboarding.botName;
        if (onboarding.bundledId && !ob.bundledId) ob.bundledId = onboarding.bundledId;
        if (onboarding.roomId) ob.roomId = onboarding.roomId;
        if (onboarding.wakeMessageId && !ob.wakeMessageId) ob.wakeMessageId = onboarding.wakeMessageId;
        if (ob.botId !== prevBotId || ob.wakeMessageId !== prevWakeId || !ob.botMessages.length) {
          void pollBotStage();
        }
      }
      return;
    }
    if (ob.open && onboarding.status === 'completed') {
      void transitionToMainNewGroup({ preview: false });
    }
  }

  function notifyUpdate() {
    if (ob.open && ob.stage === 'bot' && !ob.preview) {
      void pollBotStage();
    }
  }

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-ob-action]');
    if (!btn) return;
    const action = btn.dataset.obAction;
    if (action === 'pick-provider') return selectProvider(btn.dataset.provider);
    if (action === 'import-local') return void handleImportLocal(btn.dataset.kind);
    if (action === 'redetect-local') { ob.localLoaded = false; return void loadCatalogAndLocal({ force: true }); }
    if (action === 'start-sub-oauth' || action === 'start-codex-oauth') return void handleStartSubOAuth(btn.dataset.kind || 'codex');
    if (action === 'cancel-oauth') return void handleCancelOAuth();
    if (action === 'close-preview') return void closePreview();
    if (action === 'preview-next') return void morphToBotStage({ botId: 'preview-codex', botName: 'Codex', bundledId: 'codex', preview: true });
    if (action === 'finish-to-main') return void transitionToMainNewGroup({ preview: ob.preview });
    if (action === 'retry-bot-check') {
      const label = ob.botName || (ob.bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
      return void sendBotReply(`@${label} 请重新自检一次本机环境与桥接；若全部正常请简洁告知已就绪，不要输出退出码或内部细节。`);
    }
    if (action === 'reply-prompt-opt') return void sendBotReply(btn.dataset.label || '');
    if (action === 'open-secret-prompt') {
      const msg = ob.botMessages.find(m => m.id === btn.dataset.msgId);
      if (msg?.prompt && window.SummonSecretInput?.open) {
        window.SummonSecretInput.open({ roomId: ob.roomId, message: msg, prompt: msg.prompt });
      }
      return;
    }
    if (action === 'reply-exec-req') {
      const api = ob.callbacks?.api;
      if (!api) return;
      try {
        await api('/api/executions/input', 'POST', {
          target: { kind: 'session', id: btn.dataset.execId },
          kind: 'reply',
          ...(btn.dataset.reqId ? { request_id: btn.dataset.reqId } : {}),
          input: btn.dataset.val || '',
        });
        await pollBotStage();
      } catch (error) {
        ob.callbacks?.toast?.(error.message || '提交失败', true);
      }
    }
  });

  document.addEventListener('input', event => {
    const form = event.target.closest('#ob-model-form');
    if (!form || !event.target.name) return;
    ob.draft[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (event.target.name === 'allowNoKey') render();
  });

  document.addEventListener('submit', async event => {
    if (event.target.id === 'ob-model-form') {
      event.preventDefault();
      void handleModelSubmit(event.target);
    } else if (event.target.dataset?.obExecReply) {
      event.preventDefault();
      const input = event.target.querySelector('input[name=val]');
      const val = String(input?.value || '').trim();
      const api = ob.callbacks?.api;
      if (!val || !api) return;
      try {
        await api('/api/executions/input', 'POST', {
          target: { kind: 'session', id: event.target.dataset.obExecReply },
          kind: 'reply',
          ...(event.target.dataset.reqId ? { request_id: event.target.dataset.reqId } : {}),
          input: val,
        });
        if (input) input.value = '';
        await pollBotStage();
      } catch (error) {
        ob.callbacks?.toast?.(error.message || '提交失败', true);
      }
    }
  });

  window.SummonOnboarding = Object.freeze({
    bind(callbacks) { ob.callbacks = callbacks; },
    preopen(stage = 'model') { void openOverlay({ stage: stage === 'bot' ? 'bot' : 'model', preview: false }); },
    syncState,
    notifyUpdate,
    startPreview() { void openOverlay({ stage: 'model', preview: true }); },
    isActive: () => ob.open,
    SUMMON_ROOM_ID,
  });
})();
