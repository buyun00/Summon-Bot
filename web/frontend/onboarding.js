'use strict';
globalThis.SummonOnboarding = (() => {
  const endpoint = '/api/model-settings/onboarding';
  const view = { open: false, dismissed: false, busy: false, reply: null, messages: [], revision: 0, error: '' };
  let bindings, progress, timer, generation = 0, actionBusy = false;
  const repaint = () => bindings?.render();
  const say = (content, sender = 'bot') => { view.messages.push({ content, sender }); view.revision++; };
  const safeError = error => String(error?.message || '暂时没有完成，请重试。')
    .replace(/Bearer\s+\S+|\b(?:sk-|xai-)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[密钥已隐藏]').slice(0, 240);

  function sync(workspace, provided) {
    bindings = provided;
    progress = workspace.onboarding;
    if (!view.open && !view.dismissed && (progress?.required || workspace.provider?.configured === false)) void open(provided);
  }

  async function open(provided = bindings) {
    bindings = provided;
    if (view.open) return;
    view.open = true;
    view.dismissed = false;
    view.reply = null;
    view.messages = [];
    bindings.show();
    say('你好，我是' + (progress?.bot?.name || '主 Bot') + '。我们先接上聊天模型，再边聊边熟悉 Summon Bot。');
    await send('hello');
  }

  function close() {
    view.open = false;
    view.dismissed = true;
    view.busy = false;
    generation++;
    clearTimeout(timer);
  }

  function schedule() {
    clearTimeout(timer);
    const phase = view.reply?.phase;
    if (view.open && (phase === 'login' || phase === 'waiting')) {
      timer = setTimeout(() => { void send(phase === 'login' ? 'poll' : 'progress'); }, 1500);
    }
  }

  async function send(action, value = '', label) {
    if (!view.open || view.busy) return;
    const current = generation, polling = ['poll', 'progress'].includes(action);
    view.busy = true;
    view.error = '';
    if (!polling) repaint();
    try {
      const reply = await bindings.api(endpoint + '/reply', 'POST', { action, value });
      if (current !== generation) return;
      if (!['hello', 'poll', 'progress'].includes(action)) {
        say(action === 'key' ? '已提交 API Key（内容已隐藏）' : label || value, 'user');
      }
      if (reply.text && (!polling || view.reply?.phase !== reply.phase)) say(reply.text);
      view.reply = reply;
      if (reply.roomId) {
        close();
        await bindings.enterRoom(reply.roomId);
        return;
      }
    } catch (error) {
      if (current !== generation) return;
      view.error = action === 'key' ? 'API Key 未保存，请检查输入和模型配置后重试。' : safeError(error);
      if (action === 'poll' && view.reply) view.reply = { ...view.reply, phase: 'login-error', login: null };
    } finally {
      if (current === generation) {
        view.busy = false;
        repaint();
        schedule();
      }
    }
  }

  async function act(action, element) {
    if (action === 'onboarding-open') return open();
    if (action === 'onboarding-close') { close(); bindings.hide(); return repaint(); }
    if (action === 'onboarding-local-setup') {
      return window.SummonDesktop?.openWorkspaceSetup(element.dataset.provider);
    }
    if (action === 'onboarding-advance') {
      if (actionBusy) return;
      actionBusy = true;
      element.disabled = true;
      try {
        progress = await bindings.api(endpoint + '/advance', 'POST', { action: element.dataset.value, step: element.dataset.step });
        await bindings.refresh();
      } finally { actionBusy = false; repaint(); }
      return;
    }
    return send(element.dataset.guideAction, element.dataset.value, element.textContent.trim());
  }

  function render({ esc, icon, avatar }) {
    const reply = view.reply;
    const button = (label, action, value = '', primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'}" data-action="onboarding-option" data-guide-action="${esc(action)}" data-value="${esc(value)}" ${view.busy ? 'disabled' : ''}>${esc(label)}</button>`;
    const options = reply?.options?.map((choice, index) => button(choice.label, choice.action, choice.value, index === 0)).join('')
      || (!reply && !view.busy ? button('重新连接', 'hello') : '');
    const login = reply?.login;
    const authorization = login ? `<div class="onboarding-authorization"><p>${login.status === 'starting' ? '正在获取授权码…' : '在授权页面完成登录后回到这里。'}</p>
      ${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${/^https:\/\//i.test(login.verificationUri || '')
        ? `<a class="primary-button" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">打开授权页面 ${icon('link', 16)}</a>` : ''}</div>` : '';
    const isKey = reply?.input === 'password', disabled = view.busy || !reply || reply.input === 'none';
    const bot = progress?.bot || { id: 'bot-entry', name: '主 Bot' };
    const messages = view.messages.map(message => `<article class="onboarding-message ${message.sender === 'user' ? 'from-user' : ''}">${message.sender === 'bot' ? avatar(bot.id, 36, '') : ''}<div class="onboarding-message-body"><span class="onboarding-sender">${message.sender === 'user' ? '你' : esc(bot.name)}</span><div class="onboarding-bubble">${esc(message.content).replace(/\n/g, '<br>')}</div></div></article>`).join('');
    return `<div class="chat-layout onboarding-chat" data-room-id="onboarding" data-ready="true"><section class="conversation"><div class="floating-header"><button class="icon-button" data-action="onboarding-close" aria-label="稍后继续">${icon('back', 22)}</button><div class="chat-title-pill">${avatar(bot.id, 32, '')}<span class="chat-title-copy"><strong>${esc(bot.name)}</strong><small>新手引导</small></span></div></div><div class="messages onboarding-messages" role="log" aria-label="新手引导对话"><div class="date-divider">从一次对话开始</div>${messages}<div class="onboarding-response">${view.busy && !reply ? '<p role="status">正在准备…</p>' : ''}${authorization}${view.error ? `<p class="onboarding-error" role="alert">${esc(view.error)}</p>` : ''}<div class="onboarding-choices">${options}</div></div></div><div class="composer-wrap"><form id="onboarding-message-form" class="composer" autocomplete="off"><input id="onboarding-input" type="${isKey ? 'password' : 'text'}" aria-label="${isKey ? 'API Key' : '引导消息'}" placeholder="${esc(reply?.placeholder || '请选择当前步骤')}" autocomplete="${isKey ? 'new-password' : 'off'}" autocapitalize="off" spellcheck="false" maxlength="${isKey ? 16000 : 2000}" ${disabled ? 'disabled' : ''}><button class="composer-send" type="submit" aria-label="发送" ${disabled ? 'disabled' : ''}>${icon('send', 22)}</button></form><div class="composer-hint">${isKey ? '密钥只用于模型连接' : reply?.phase === 'ready' ? '下一条对话由你选择的模型回复' : '主 Bot · 欢迎引导'}</div></div></section></div>`;
  }

  function renderStep(roomId, esc) {
    const guide = progress?.guide;
    if (!guide || progress.roomId !== roomId) return '';
    const local = guide.localControl;
    const localDesktop = document.documentElement.dataset.localWorkspace === 'true';
    const localSetup = local && (localDesktop
      ? `<button class="secondary-button" data-action="onboarding-local-setup" data-provider="${esc(local.provider)}">在部署机上配置</button>`
      : '<small>在部署机的桌面应用或安装 CLI 中完成配置。</small>');
    const codexSetup = localDesktop && guide.step === 'codex' && guide.options.some(item => item.action === 'connect-codex')
      ? '<button class="secondary-button" data-action="onboarding-local-setup" data-provider="codex">准备本机 Codex 会话</button>' : '';
    return `<aside class="onboarding-step" aria-label="新手引导"><p>${esc(guide.text)}</p>${guide.error ? `<p role="status">${esc(guide.error)}</p>` : ''}${local?.origin ? `<p><a href="${esc(local.origin)}" target="_blank" rel="noopener noreferrer">${esc(local.origin)}</a></p>` : ''}<div class="onboarding-choices">${localSetup || ''}${codexSetup}${guide.options.map(item => `<button class="secondary-button" data-action="onboarding-advance" data-step="${esc(guide.step)}" data-value="${esc(item.action)}" ${actionBusy ? 'disabled' : ''}>${esc(item.label)}</button>`).join('')}</div></aside>`;
  }

  document.addEventListener('submit', event => {
    if (event.target.id !== 'onboarding-message-form') return;
    event.preventDefault();
    const field = event.target.querySelector('input'), value = field.value.trim();
    field.value = '';
    if (value) void send(view.reply.phase === 'ready' ? 'handoff' : view.reply.phase, value);
  });

  return { sync, open, close, act, render, renderStep, visible: () => view.open, key: () => `${view.reply?.phase}:${view.revision}` };
})();
