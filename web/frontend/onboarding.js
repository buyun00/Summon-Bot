'use strict';
globalThis.SummonOnboarding = (() => {
  const view = { open: false, dismissed: false, automatic: false, step: 'choice', messages: [], revision: 0, busy: false, data: null, sources: [], draft: {}, choices: [], login: null, error: '' };
  let bindings, loading, loginTimer, loginGeneration = 0;
  const brand = kind => kind === 'codex' ? 'Codex' : 'Grok';
  const active = () => view.data?.modelSettings?.connections.find(entry => entry.active && entry.configured);
  const say = (content, sender = 'bot') => { view.messages.push({ content, sender }); view.revision++; };
  const secretLike = text => /\b(?:sk-|xai-)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|^(?=[A-Za-z0-9_+/=]{32,}$)(?=.*[A-Za-z])(?=.*\d)/.test(text);
  const safeError = error => String(error?.message || '暂时没有完成，请重试。').replace(/Bearer\s+\S+/gi, '[密钥已隐藏]').replace(/\b(?:sk-|xai-)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[密钥已隐藏]').slice(0, 500);
  const repaint = () => bindings?.render();
  function sync(workspace, provided) {
    bindings = provided;
    if (!view.open && !view.dismissed && (workspace.onboarding?.required || workspace.provider?.configured === false)) {
      view.automatic = true; void open(provided, true);
    }
    if (view.open && view.automatic && workspace.onboarding?.status === 'complete' && workspace.onboarding.roomId && !view.busy) close();
  }
  async function open(provided = bindings, automatic = false) {
    bindings = provided; view.open = true; view.automatic = automatic; view.dismissed = false;
    bindings.show();
    if (!view.messages.length) say('你好，我是主 Bot，欢迎来到 Summon Bot。以后你可以直接把想做的事告诉我。\n\n我们先把聊天模型接上，我再陪你一步步熟悉这里。');
    repaint();
    if (loading) return loading;
    if (view.data && !['choice', 'ready'].includes(view.step)) { if (view.login) scheduleLogin(); return; }
    loading = detect().finally(() => { loading = null; });
    return loading;
  }
  function close() { view.open = false; view.dismissed = true; clearTimeout(loginTimer); }
  async function detect() {
    view.busy = true; view.error = ''; repaint();
    try {
      const [data, local] = await Promise.all([bindings.api('/api/model-settings/onboarding'), bindings.api('/api/model-settings/local')]);
      view.data = data; view.sources = local.sources || [];
      const current = active();
      if (current) ready(current, '你已经有一个聊天模型了');
      else {
        view.step = 'choice';
        const found = view.sources.filter(source => source.available).map(source => source.name);
        say(found.length ? `在运行 Summon Bot 的这台机器上，找到了 ${found.join(' 和 ')} 登录。要直接导入吗？也可以用 API Key。`
          : '在运行 Summon Bot 的这台机器上，没有找到可导入的 Codex 或 Grok 登录。我们可以用 API Key 接上模型；有订阅的话，也可以直接授权登录。');
      }
    } catch (error) { view.error = safeError(error); }
    finally { view.busy = false; repaint(); }
  }
  function ready(entry, lead = '模型配置已经保存') {
    view.data.modelSettings.activeId = entry.id;
    view.data.modelSettings.connections.forEach(item => { item.active = item.id === entry.id; });
    view.step = 'ready'; view.draft = {}; view.login = null; clearTimeout(loginTimer);
    say(`${lead}：${entry.name} · ${entry.model}。\n\n接下来发起第一条真实对话，由我继续介绍和配置。你想先用 Summon Bot 做什么，我们可以边聊边来。`);
  }
  function chooseProvider(id) {
    const preset = view.data.modelSettings.presets.find(item => item.id === id);
    if (!preset) throw new Error('请选择一个模型服务商');
    say(preset.name, 'user');
    const existing = view.data.modelSettings.connections.find(entry => entry.id === `onboarding-api-${id}`);
    view.draft = { kind: 'api', id: `onboarding-api-${id}`, name: preset.name, provider: id, api: preset.api,
      baseUrl: preset.baseUrl, contextWindow: 128000, maxTokens: 8192, ...(existing || {}) };
    view.choices = preset.models || [];
    if (!preset.baseUrl) { view.step = 'endpoint'; say('把这个服务的 API 地址告诉我，例如 https://api.example.com/v1。'); }
    else askModel();
  }
  function askModel() {
    view.step = view.draft.kind === 'api' ? 'model' : 'subscription-model';
    say('你想用哪个聊天模型？可以点下面的模型，也可以直接输入模型 ID。');
  }
  function setModel(id) {
    const model = String(id).trim();
    if (!model || model.length > 200 || /[\u0000-\u001f]/.test(model)) throw new Error('请填写有效的模型 ID');
    if (secretLike(model)) throw new Error('这看起来像密钥。先选择模型，下一步会提供隐藏密钥的安全输入。');
    say(model, 'user'); view.draft.model = model;
    const choice = view.choices.find(item => item.id === model);
    if (choice?.contextWindow) view.draft.contextWindow = choice.contextWindow;
    if (choice?.maxTokens) view.draft.maxTokens = Math.min(choice.maxTokens, 8192);
    if (view.draft.kind !== 'api') return saveSubscription();
    view.step = 'key'; say('最后，粘贴这个服务的 API Key。输入内容会隐藏，只用于保存模型连接，不会进入聊天记录。');
  }
  async function select(id) {
    const settings = await bindings.api('/api/model-settings/active', 'POST', { id });
    view.data.modelSettings = settings;
    ready(settings.connections.find(item => item.id === id));
    await bindings.refresh();
  }
  async function saveSubscription() {
    view.data.modelSettings = await bindings.api('/api/model-settings/connections', 'POST', view.draft);
    await select(view.draft.id);
  }
  async function importLocal(kind) {
    say(`导入本机 ${brand(kind)} 登录`, 'user');
    const settings = await bindings.api('/api/model-settings/local/import', 'POST', { kind });
    view.data.modelSettings = settings;
    view.draft = { ...settings.connections.find(item => item.id === settings.importedId) };
    view.choices = (await bindings.api(`/api/model-settings/connections/${encodeURIComponent(view.draft.id)}/models`)).models || [];
    say(`${brand(kind)} 登录已导入。`); askModel();
  }
  async function authorize(kind) {
    say(`登录 ${brand(kind)} 订阅`, 'user');
    const id = `onboarding-${kind}`;
    view.data.modelSettings = await bindings.api('/api/model-settings/connections', 'POST', { kind, id, name: `${brand(kind)} 订阅` });
    view.draft = { ...view.data.modelSettings.connections.find(item => item.id === id) };
    view.choices = (await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/models`)).models || [];
    if (view.draft.configured) { askModel(); return; }
    view.step = 'oauth';
    say(`在 ${brand(kind)} 的授权页完成登录就好，我会在这里等你。`);
    view.login = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/login`, 'POST', {});
    scheduleLogin();
  }
  function scheduleLogin() {
    clearTimeout(loginTimer);
    if (view.open && view.login && ['starting', 'waiting'].includes(view.login.status)) loginTimer = setTimeout(() => { void pollLogin(); }, 2000);
  }
  async function pollLogin() {
    const id = view.login?.id, generation = loginGeneration;
    if (!id || !view.open) return;
    try {
      const login = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/login`);
      if (generation !== loginGeneration || view.login?.id !== id) return;
      view.login = login; view.error = '';
      if (login.status === 'completed') {
        view.data.modelSettings = await bindings.api('/api/model-settings');
        view.draft = { ...view.data.modelSettings.connections.find(entry => entry.id === id) };
        say('订阅授权完成。'); view.login = null; askModel();
      } else if (['failed', 'cancelled', 'idle'].includes(login.status)) {
        view.error = login.error ? safeError({ message: login.error }) : '授权已结束，可以重新登录或改用 API Key。';
      }
    } catch (error) { view.error = safeError(error); }
    finally { repaint(); if (generation === loginGeneration) scheduleLogin(); }
  }
  async function cancelLogin() {
    loginGeneration++; clearTimeout(loginTimer);
    const login = view.login; view.login = null;
    if (login) await bindings.api(`/api/model-settings/connections/${encodeURIComponent(login.id)}/login`, 'DELETE', {});
  }
  async function submit(text) {
    if (view.busy) return;
    text = text.trim(); if (!text) return;
    view.busy = true; view.error = ''; repaint();
    try {
      if (view.step !== 'key' && secretLike(text)) throw new Error('这看起来像密钥，我没有把它写进对话。请先选择服务商和模型，再在隐藏输入中填写 API Key。');
      if (view.step === 'key') {
        say('已提交 API Key（内容已隐藏）', 'user');
        view.data.modelSettings = await bindings.api('/api/model-settings/connections', 'POST', { ...view.draft, apiKey: text, allowNoKey: false });
        text = ''; await select(view.draft.id);
      } else if (['model', 'subscription-model'].includes(view.step)) await setModel(text);
      else if (view.step === 'endpoint') {
        const url = new URL(text);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含密钥和查询参数的 API 地址');
        view.draft.baseUrl = url.href.replace(/\/+$/, ''); say(view.draft.baseUrl, 'user');
        view.step = 'protocol'; say('这个服务使用哪种接口？一般的 OpenAI 兼容服务可以选择 Chat Completions。');
      } else if (view.step === 'provider') {
        const preset = view.data.modelSettings.presets.find(item => item.id.toLowerCase() === text.toLowerCase() || item.name.toLowerCase() === text.toLowerCase());
        if (!preset) throw new Error('可以点选下面的服务商；自己的服务请选择“其他 / 自定义地址”。');
        chooseProvider(preset.id);
      } else if (view.step === 'choice') {
        if (/api|key|密钥/i.test(text)) { say('使用 API Key', 'user'); view.step = 'provider'; say('你用的是哪家的模型服务？'); }
        else if (/codex|grok/i.test(text)) {
          const kind = /codex/i.test(text) ? 'codex' : 'grok';
          if (view.sources.some(source => source.kind === kind && source.available)) await importLocal(kind); else await authorize(kind);
        } else throw new Error('模型接通后就能自由聊天了。先选导入订阅，或回复“API Key”开始配置。');
      } else if (view.step === 'ready') { say(text, 'user'); await handoff(text); }
      else throw new Error('先完成下面的授权或选项，我们就可以继续。');
    } catch (error) { view.error = safeError(error); }
    finally { text = ''; view.busy = false; repaint(); }
  }
  async function handoff(message = '') {
    const progress = await bindings.api('/api/model-settings/onboarding/start', 'POST', { message });
    close(); view.messages = []; view.data = null; view.step = 'choice';
    await bindings.enterRoom(progress.roomId);
  }
  async function act(action, element) {
    if (action === 'onboarding-open') return open();
    if (action === 'onboarding-close') { close(); bindings.hide(); return repaint(); }
    if (view.busy) return;
    view.busy = true; view.error = ''; repaint();
    try {
      const value = element?.dataset.value;
      if (action === 'onboarding-detect') await detect();
      if (action === 'onboarding-import') await importLocal(value);
      if (action === 'onboarding-authorize') await authorize(value);
      if (action === 'onboarding-api') { await cancelLogin(); say('使用 API Key', 'user'); view.step = 'provider'; say('你用的是哪家的模型服务？'); }
      if (action === 'onboarding-provider') chooseProvider(value);
      if (action === 'onboarding-protocol') { view.draft.api = value; say(value, 'user'); askModel(); }
      if (action === 'onboarding-model') await setModel(value);
      if (action === 'onboarding-select') { const entry = view.data.modelSettings.connections.find(item => item.id === value); say(`使用 ${entry.name}`, 'user'); await select(value); }
      if (action === 'onboarding-no-key') { say('使用无需 Key 的服务', 'user'); view.data.modelSettings = await bindings.api('/api/model-settings/connections', 'POST', { ...view.draft, allowNoKey: true }); await select(view.draft.id); }
      if (action === 'onboarding-back') { await cancelLogin(); view.step = 'choice'; view.draft = {}; say('没问题，我们重新选择连接方式。'); }
      if (action === 'onboarding-start') { say('开始，带我熟悉一下', 'user'); await handoff(); }
    } catch (error) { view.error = safeError(error); }
    finally { view.busy = false; repaint(); }
  }
  function render({ esc, icon, avatar }) {
    const button = (title, action, value = '', primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'}" data-action="onboarding-${action}" data-value="${esc(value)}" ${view.busy ? 'disabled' : ''}>${esc(title)}</button>`;
    let options = '';
    if (view.data && view.step === 'choice') options = view.sources.filter(source => source.available).map(source => button(`导入本机 ${source.name} 登录`, 'import', source.kind, true)).join('')
      + view.data.modelSettings.connections.filter(entry => entry.configured).map(entry => button(`使用 ${entry.name}`, 'select', entry.id)).join('')
      + button('使用 API Key', 'api', '', !view.sources.some(source => source.available)) + button('登录 Codex 订阅', 'authorize', 'codex') + button('登录 Grok 订阅', 'authorize', 'grok') + button('重新查找', 'detect');
    if (view.data && view.step === 'provider') options = view.data.modelSettings.presets.map(preset => button(preset.name, 'provider', preset.id)).join('');
    if (view.step === 'protocol') options = [['Chat Completions', 'openai-completions'], ['Responses', 'openai-responses'], ['Anthropic Messages', 'anthropic-messages']].map(([label, api]) => button(label, 'protocol', api)).join('');
    if (['model', 'subscription-model'].includes(view.step)) {
      const recommended = view.draft.model ? [view.choices.find(choice => choice.id === view.draft.model) || { id: view.draft.model }, ...view.choices.filter(choice => choice.id !== view.draft.model)] : view.choices;
      options = recommended.slice(0, 6).map(choice => button(choice.id, 'model', choice.id)).join('');
    }
    if (view.step === 'key') options = button('这是无需 Key 的本地服务', 'no-key');
    if (view.step === 'ready') options = button('开始，带我熟悉一下', 'start', '', true) + button('换一个模型', 'back');
    if (view.step !== 'choice' && view.step !== 'ready') options += button('换一种连接方式', 'back');
    if (view.error && !view.data) options = button('重新连接', 'detect');
    const login = view.login, uri = login?.verificationUri;
    const trustedUri = uri && /^https:\/\//i.test(uri) ? uri : null;
    const authorization = view.step === 'oauth' && login ? `<div class="onboarding-authorization"><p>${login.status === 'starting' ? '正在获取授权码…' : login.status === 'waiting' ? '在授权页面输入这个代码：' : '授权暂未完成，可以更换连接方式后重试。'}</p>${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${trustedUri ? `<a class="primary-button" href="${esc(trustedUri)}" target="_blank" rel="noopener noreferrer">打开授权页面 ${icon('link', 16)}</a>` : ''}</div>` : '';
    const isKey = view.step === 'key', placeholder = isKey ? '粘贴 API Key，输入会隐藏' : view.step === 'endpoint' ? '输入 API 地址…' : ['model', 'subscription-model'].includes(view.step) ? '输入模型 ID…' : view.step === 'ready' ? '回复“开始”，继续和主 Bot 聊…' : '输入 Codex、Grok 或 API Key…';
    const messages = view.messages.map(message => `<article class="onboarding-message ${message.sender === 'user' ? 'from-user' : ''}">${message.sender === 'bot' ? avatar('bot-entry', 36, '') : ''}<div class="onboarding-message-body"><span class="onboarding-sender">${message.sender === 'user' ? '你' : '主 Bot'}</span><div class="onboarding-bubble">${esc(message.content).replace(/\n/g, '<br>')}</div></div></article>`).join('');
    return `<div class="chat-layout onboarding-chat" data-room-id="onboarding" data-ready="true"><section class="conversation"><div class="floating-header"><button class="icon-button" data-action="onboarding-close" aria-label="稍后继续">${icon('back', 22)}</button><div class="chat-title-pill">${avatar('bot-entry', 32, '')}<span class="chat-title-copy"><strong>主 Bot</strong><small>初次见面</small></span></div></div><div class="messages onboarding-messages" role="log" aria-label="新手引导对话"><div class="date-divider">从一次对话开始</div>${messages}<div class="onboarding-response">${view.busy ? '<p class="onboarding-working" role="status">正在准备…</p>' : ''}${authorization}${view.error ? `<p class="onboarding-error" role="alert">${esc(view.error)}</p>` : ''}<div class="onboarding-choices">${options}</div></div></div><div class="composer-wrap"><form id="onboarding-message-form" class="composer" autocomplete="off"><input id="onboarding-input" type="${isKey ? 'password' : 'text'}" aria-label="${isKey ? 'API Key（不会保存到聊天）' : '引导消息'}" placeholder="${esc(placeholder)}" ${isKey ? 'autocomplete="new-password"' : 'autocomplete="off"'} autocapitalize="off" spellcheck="false" maxlength="${isKey ? 16000 : 200}" ${view.busy || !view.data || ['oauth', 'protocol'].includes(view.step) ? 'disabled' : ''}><button class="composer-send" type="submit" aria-label="发送" ${view.busy || !view.data || ['oauth', 'protocol'].includes(view.step) ? 'disabled' : ''}>${icon('send', 22)}</button></form><div class="composer-hint">${isKey ? '密钥只用于模型连接，不会作为消息发送' : view.step === 'ready' ? '下一条对话由你选择的模型回复' : '模型接通前，由本地引导陪你完成连接'}</div></div></section></div>`;
  }
  document.addEventListener('submit', event => {
    if (event.target.id !== 'onboarding-message-form') return;
    event.preventDefault(); const field = event.target.querySelector('input'), text = field.value; field.value = ''; void submit(text);
  });
  return { sync, open, close, act, render, visible: () => view.open, key: () => `${view.step}:${view.revision}` };
})();
