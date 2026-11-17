'use strict';
const setup = window.SummonSetup;
const transcript = document.querySelector('#conversation');
const controls = document.querySelector('#controls');
const status = document.querySelector('#status');
const welcome = document.querySelector('#welcome');
const title = document.querySelector('#title');
let connection, localAvailable, busy = false;
const releaseControls = document.querySelector('#release-controls');

function say(text) {
  const row = document.createElement('div');
  row.className = 'message';
  const icon = new Image();
  icon.src = 'icon.png';
  icon.alt = '';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(icon, bubble);
  transcript.append(row);
}

function button(label, action, primary = false, independent = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (primary) element.className = 'primary';
  element.onclick = independent ? () => void action().catch(() => renderUpdates({ status: 'error' })) : () => void perform(action);
  return element;
}

function buttons(...items) {
  const row = document.createElement('div');
  row.className = 'buttons';
  row.append(...items);
  controls.append(row);
}

function renderUpdates(value) {
  const installable = ['downloaded', 'manual'].includes(value?.status);
  const check = async () => renderUpdates(await setup.checkForUpdates());
  const updateButton = button(value?.status === 'downloaded' ? '重启并更新' : installable ? '下载更新' : '检查更新', async () => {
    if (installable) await setup.installUpdate();
    else await check();
  }, false, true);
  updateButton.disabled = ['checking', 'downloading'].includes(value?.status);
  const detail = document.createElement('small');
  detail.setAttribute('role', 'status');
  const labels = {
    checking: '正在检查更新…', downloading: '正在下载更新 ' + (value?.percent || 0) + '%',
    downloaded: '更新已下载', manual: '发现新版本', current: '当前已是最新版本',
    unpublished: '暂未发布新版', error: '暂时无法检查更新',
  };
  detail.textContent = labels[value?.status] || '';
  releaseControls.replaceChildren(updateButton, ...(installable ? [button('重新检查', check, false, true)] : []), detail);
}

function field(label, name, { type = 'text', placeholder = '', value = '', required = false } = {}) {
  const element = document.createElement('label');
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.required = required;
  input.autocomplete = type === 'password' ? 'new-password' : 'off';
  input.spellcheck = false;
  if (type === 'checkbox') { element.className = 'check'; element.append(input, label); }
  else element.append(label, input);
  return element;
}

function form(fields, label, submit) {
  controls.replaceChildren();
  const form = document.createElement('form');
  const action = document.createElement('button');
  action.type = 'submit';
  action.className = 'primary';
  action.textContent = label;
  form.append(...fields, action);
  controls.append(form);
  form.onsubmit = event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
    void perform(() => submit(values));
  };
}

function message(error) {
  return String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function perform(action) {
  if (busy) return;
  busy = true;
  status.textContent = '正在处理…';
  controls.inert = true;
  try {
    await action();
    if (status.textContent === '正在处理…') status.textContent = '';
  } catch (error) {
    status.textContent = message(error);
  } finally {
    busy = false;
    controls.inert = false;
  }
}

function showWelcome(label) {
  welcome.hidden = false;
  title.textContent = label;
  transcript.replaceChildren();
  controls.replaceChildren();
  status.textContent = '';
  title.focus({ preventScroll: true });
}

function showRetry() {
  showWelcome('连接实例');
  if (connection) say(connection.origin);
  buttons(button('重试当前实例', () => setup.action('continue'), true),
    button('选择其他实例', () => setup.action('choose-instance')));
}

function showInstances() {
  showWelcome('选择实例');
  if (localAvailable) buttons(button('本机正式实例', () => setup.action('connect-local'), true));
  buttons(button('连接已有实例', showRemote, !localAvailable));
  if (connection) buttons(button('回到当前实例', () => setup.action('continue')));
  if (connection?.mode === 'local') {
    buttons(button('Cloudflare Tunnel', () => showAccess('cloudflare')), button('Tailscale Serve', () => showAccess('tailscale')));
  }
}

function showRemote() {
  showWelcome('连接已有实例');
  say('访问令牌由实例部署者提供。已登录的实例可沿用当前会话。');
  const previous = connection?.mode === 'remote' ? connection : null;
  form([field('实例地址', 'address', { type: 'url', placeholder: 'https://', value: previous?.origin || '', required: true }),
    field('访问令牌', 'token', { type: 'password' })],
    '连接实例', values => setup.action('connect-remote', { address: values.address.trim(), token: values.token.trim() }));
  buttons(button('返回实例选择', showInstances));
}

const statusText = {
  missing: '部署机还没有安装所需组件。', 'needs-login': '请先在部署机登录 Tailscale。',
  'needs-https': '请先在 tailnet 启用 HTTPS。', 'needs-authorization': '需要在官方授权页确认 HTTPS，然后回到这里重试。',
  conflict: '所选端口已有其他映射或启用了 Funnel。请使用未占用的 HTTPS 端口。',
  configured: '检测到可复用的现有 Serve 映射。', available: '可以准备新的入口。',
  registered: '入口已登记。', reachable: '可以通过该地址访问这个实例。',
  stopped: '本机连接器已停止。', unavailable: '暂时无法读取或修改配置，请检查组件、登录和本机权限。',
  'waiting-connector': '正在等待 cloudflared 连接到 Cloudflare。', 'connector-unavailable': 'cloudflared 启动失败，请检查版本和令牌。',
  'mapping-unconfirmed': '暂时无法确认 Serve 映射，请查询状态后再试。', revoked: '已撤销该入口的登记。',
};

function describe(result) {
  say((statusText[result.state] || '请检查当前接入状态。') + (result.origin ? '\n' + result.origin : '')
    + (result.reachable === false && result.registered ? '\n当前未能通过该地址访问这个实例。请核对代理目标和网络。' : ''));
}

function accessLinks(provider, result) {
  if (result.docsUrl) {
    const link = document.createElement('a');
    link.className = 'button';
    link.href = result.docsUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '官方安装指引';
    buttons(link);
  }
  if (result.authorizationAvailable) buttons(button('打开官方授权页', () => setup.action('authorize', { provider })));
}

function accessNavigation() {
  buttons(button('返回实例', () => setup.action('continue')), button('返回实例选择', showInstances));
}

async function showAccess(provider) {
  showWelcome(provider === 'tailscale' ? 'Tailscale Serve' : 'Cloudflare Tunnel');
  accessNavigation();
  const result = await setup.action('access', { action: 'status', provider });
  describe(result);
  const fields = provider === 'tailscale' ? [field('Serve HTTPS 端口', 'port', { type: 'number', placeholder: '443' })]
    : [field('已经发布的 HTTPS 主机名', 'origin', { type: 'url', value: result.origin || '' }),
      field('使用 Summon 管理 cloudflared', 'managed', { type: 'checkbox' })];
  form(fields, '准备入口', async values => {
    const plan = await setup.action('access', { action: 'prepare', provider, origin: values.origin, port: values.port,
      owner: provider === 'cloudflare' ? values.managed ? 'summon' : result.owner || 'external' : undefined });
    if (plan.state !== 'prepared') { describe(plan); accessLinks(provider, plan); return; }
    confirmAccess(provider, plan);
  });
  accessLinks(provider, result);
  if (result.registered || result.owner === 'summon') buttons(button('撤销入口…', () => {
    say('撤销会移除这条登记，并停止 Summon 自己管理的转发。');
    controls.replaceChildren();
    buttons(button('确认撤销', async () => {
      await setup.action('access', { action: 'revoke', provider, confirm: true });
      await showAccess(provider);
    }, true), button('取消', () => showAccess(provider)));
  }));
  accessNavigation();
}

function confirmAccess(provider, plan) {
  say((plan.reuse ? '将复用现有映射。' : '请确认这个 HTTPS 入口。') + '\n' + plan.origin + ' → ' + plan.target);
  form(plan.owner === 'summon' && provider === 'cloudflare' ? [field('隧道令牌', 'token', {
    type: 'password', placeholder: plan.needsToken ? '粘贴已建隧道的令牌' : '留空沿用已保存的令牌',
  })] : [], '确认并应用', async values => {
    const result = await setup.action('access', { action: 'apply', provider, confirm: true, planId: plan.planId, token: values.token?.trim() });
    describe(result);
    accessLinks(provider, result);
    if (['registered', 'reachable'].includes(result.state)) {
      controls.replaceChildren();
      buttons(button('回到实例', () => setup.action('continue'), true), button('查看接入设置', () => showAccess(provider)));
    }
  });
  buttons(button('返回', () => showAccess(provider)));
}

async function open() {
  try {
    const info = await setup.info();
    ({ connection, localAvailable } = info);
    if (info.section === 'retry') showRetry();
    else if (info.section === 'remote') showRemote();
    else if (['cloudflare', 'tailscale'].includes(info.section)) await perform(() => showAccess(info.section));
    else showInstances();
    renderUpdates(info.update);
    if (info.error || info.selectionWarning) status.textContent = info.error || info.selectionWarning;
  } catch (error) {
    showInstances();
    status.textContent = message(error);
  }
}

setup.onUpdate(renderUpdates);
setup.onSetup(() => void open());
void open();
