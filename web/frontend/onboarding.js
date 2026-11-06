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
    if (progress?.required) say('你好，我是' + (progress?.bot?.name || '主 Bot') + '。我们先设置聊天模型。');
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
    if (view.open && phase === 'login') {
      timer = setTimeout(() => { void send('poll'); }, 1500);
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
    if (action === 'onboarding-choice') {
      if (actionBusy) return;
      actionBusy = true;
      repaint();
      try {
        await bindings.api(endpoint + '/advance', 'POST', { action: element.dataset.value, step: element.dataset.step,
          messageId: element.dataset.messageId, requestId: crypto.randomUUID() });
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
    const activity = view.busy && !reply ? '<p class="onboarding-working" role="status">正在准备…</p>' : '';
    return `<div class="chat-layout onboarding-chat" data-room-id="onboarding" data-ready="true"><section class="conversation"><div class="floating-header"><button class="icon-button" data-action="onboarding-close" aria-label="稍后继续">${icon('back', 22)}</button><div class="chat-title-pill">${avatar(bot.id, 32, '')}<span class="chat-title-copy"><strong>${esc(bot.name)}</strong><small>新手引导</small></span></div></div><div class="messages onboarding-messages" role="log" aria-label="新手引导对话"><div class="date-divider">从一次对话开始</div>${messages}<div class="onboarding-response">${activity}${authorization}${view.error ? `<p class="onboarding-error" role="alert">${esc(view.error)}</p>` : ''}<div class="onboarding-choices">${options}</div></div></div><div class="composer-wrap"><form id="onboarding-message-form" class="composer" autocomplete="off"><input id="onboarding-input" type="${isKey ? 'password' : 'text'}" aria-label="${isKey ? 'API Key' : '引导消息'}" placeholder="${esc(reply?.placeholder || '请选择当前步骤')}" autocomplete="${isKey ? 'new-password' : 'off'}" autocapitalize="off" spellcheck="false" maxlength="${isKey ? 16000 : 2000}" ${disabled ? 'disabled' : ''}><button class="composer-send" type="submit" aria-label="发送" ${disabled ? 'disabled' : ''}>${icon('send', 22)}</button></form><div class="composer-hint">${isKey ? '密钥只用于模型连接' : reply?.phase === 'ready' ? '下一条对话由你选择的模型回复' : '主 Bot · 欢迎引导'}</div></div></section></div>`;
  }

  function renderFollowup(message, esc) {
    const guide = progress?.guide;
    if (!guide || guide.messageId !== message.id) return '';
    const local = guide.localControl, onHost = document.documentElement.dataset.localWorkspace === 'true';
    const setupLabel = local && { cloudflare: '配置 Cloudflare Tunnel', tailscale: '配置 Tailscale Serve' }[local.provider];
    const setup = local?.origin?.startsWith('https://')
      ? `<p><a href="${esc(local.origin)}" target="_blank" rel="noopener noreferrer">${esc(local.origin)}</a></p>`
      : onHost && setupLabel
        ? `<button type="button" class="secondary-button" data-action="onboarding-local-setup" data-provider="${esc(local.provider)}">${setupLabel}</button>`
        : local ? '<small>请在部署机的桌面应用或安装 CLI 中完成设置。</small>' : '';
    const install = { codex: 'https://developers.openai.com/codex/cli', grok: 'https://docs.x.ai/build/overview', 'claude-code': 'https://code.claude.com/docs/en/setup' }[guide.step];
    const working = guide.setup && ['queued', 'active'].includes(guide.setup.status);
    const setupStatus = guide.setup ? `<p class="onboarding-working" role="status">${esc(working ? 'Pi 正在配置，有问题我会继续处理…' : guide.setup.status === 'waiting' ? '正在等待当前配置所需的授权或信息，可以直接在聊天中继续。' : '可以直接在聊天中补充信息，让我接着处理。')}</p>` : '';
    const options = guide.options.map(choice => `<button type="button" class="secondary-button" data-action="onboarding-choice" data-step="${esc(guide.step)}" data-message-id="${esc(message.id)}" data-value="${esc(choice.action)}" ${actionBusy || working && ['connect-engine', 'check'].includes(choice.action) ? 'disabled' : ''}>${esc(choice.label)}</button>`).join('');
    return `<div class="onboarding-followup">${guide.error ? `<p class="onboarding-error" role="alert">${esc(guide.error)}</p>` : ''}
      ${setupStatus}<div class="onboarding-choices">${setup}${options}${install ? `<a href="${esc(install)}" target="_blank" rel="noopener noreferrer">官方安装指引</a>` : ''}</div></div>`;
  }

  function visibleMessages(messages) {
    const hidden = new Set(messages.filter(message => message.sourceRefs?.includes('summon:onboarding')
      && /^summon-onboarding-(?:start|conversation)(?:-\d+)?$/.test(message.clientId || '')
      && (message.senderId === 'system' || message.senderId === 'user'
        && message.content === '聊天模型已接好。请带我熟悉 Summon Bot，先问我最想做什么。')).map(message => message.id));
    return messages.filter(message => !hidden.has(message.id) && !(message.jobId && hidden.has(message.replyTo)));
  }

  document.addEventListener('submit', event => {
    if (event.target.id !== 'onboarding-message-form') return;
    event.preventDefault();
    const field = event.target.querySelector('input'), value = field.value.trim();
    field.value = '';
    if (value) void send(view.reply.phase === 'ready' ? 'handoff' : view.reply.phase, value);
  });

  return { sync, open, close, act, render, renderFollowup, visibleMessages, visible: () => view.open, key: () => `${view.reply?.phase}:${view.revision}` };
})();
