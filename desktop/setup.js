'use strict';
const setup = window.SummonSetup;
const transcript = document.querySelector('#conversation');
const controls = document.querySelector('#controls');
const status = document.querySelector('#status');
const welcome = document.querySelector('#welcome');
const unpacking = document.querySelector('#unpacking');
const parcel = unpacking.querySelector('.parcel');
const strip = parcel.querySelector('.parcel-strip');
const lid = parcel.querySelector('.parcel-lid');
const parcelTitle = document.querySelector('#unpacking-title');
const parcelActions = document.querySelector('#parcel-actions');
const stageLabel = document.querySelector('#unpacking-stage');
const stageDetail = document.querySelector('#unpacking-detail');
const unpackingStages = new Map([
  ['choice', [0, '发现一个已有的工作区', '你想继续用原来的工作区，还是新建一个？']],
  ['prepare', [3, '正在准备本机工作区', '首次创建需要准备运行组件并启动服务，请稍等片刻。']],
  ['runtime', [8, '正在复制运行组件', '首次创建需要复制本机运行所需的文件。']],
  ['gateway', [60, '正在启动主 Bot', '正在打开工作区的数据和本机能力。']],
  ['web', [82, '正在启动工作区页面', '正在为主界面准备本机地址。']],
  ['verify', [94, '正在确认工作区就绪', '正在检查服务和工作区连接。']],
  ['ready', [100, '工作区准备好了', '正在打开箱盖。']],
]);
let workspace, busy = false;

function say(text, user = false) {
  const row = document.createElement('div');
  row.className = user ? 'message user' : 'message';
  if (!user) {
    const icon = new Image(); icon.src = 'icon.png'; icon.alt = '主 Bot';
    row.append(icon);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble'; bubble.textContent = text;
  row.append(bubble); transcript.append(row);
}

function button(label, action, primary = false) {
  const element = document.createElement('button');
  element.type = 'button'; element.textContent = label;
  if (primary) element.className = 'primary';
  element.onclick = () => void perform(action);
  return element;
}

function buttons(...items) {
  const row = document.createElement('div'); row.className = 'buttons';
  row.append(...items); controls.append(row);
}

function field(label, name, { type = 'text', placeholder = '', value = '' } = {}) {
  const element = document.createElement('label');
  const input = document.createElement('input');
  input.name = name; input.type = type; input.value = value; input.placeholder = placeholder;
  input.autocomplete = type === 'password' ? 'new-password' : 'off'; input.spellcheck = false;
  if (type === 'checkbox') { element.className = 'check'; element.append(input, label); }
  else element.append(label, input);
  return element;
}

function form(fields, label, submit) {
  controls.replaceChildren();
  const form = document.createElement('form');
  const action = document.createElement('button');
  action.type = 'submit'; action.className = 'primary'; action.textContent = label;
  form.append(...fields, action); controls.append(form);
  form.onsubmit = event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
    void perform(() => submit(values));
  };
}

async function perform(action) {
  if (busy) return;
  busy = true; status.textContent = '正在处理…';
  controls.inert = true;
  try {
    await action();
    if (status.textContent === '正在处理…') status.textContent = '';
  }
  catch (error) { status.textContent = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { busy = false; controls.inert = false; }
}

function unpackingProgress({ stage, ratio }) {
  const info = unpackingStages.get(stage);
  if (!info) return;
  const [start, label, detail] = info;
  const percent = stage === 'runtime' ? Math.round(100 * ratio) : 0;
  const position = start + Math.round(.46 * percent);
  strip.style.setProperty('--tear-progress', position + '%');
  const peek = Math.min(85, Math.max(0, (position - 20) * 1.65));
  parcel.style.setProperty('--peek-rise', peek + '%');
  parcel.toggleAttribute('data-peek', peek > 35);
  strip.setAttribute('aria-valuenow', position);
  strip.setAttribute('aria-valuetext', label);
  if (stageLabel.textContent !== label) stageLabel.textContent = label;
  stageDetail.textContent = percent ? `已复制 ${percent}% 的运行组件` : detail;
}

function showParcel() {
  welcome.hidden = true;
  unpacking.hidden = false;
  parcelActions.hidden = true;
}

function chooseParcel(root) {
  parcel.classList.remove('is-open');
  showParcel();
  parcelTitle.textContent = '打开你的工作区';
  unpackingProgress({ stage: 'choice' });
  parcelActions.replaceChildren(button('使用已有工作区', () => unpackLocal('local', root, true), true),
    button('新建工作区', () => unpackLocal('new', undefined, true)));
  parcelActions.hidden = false;
}

async function unpackLocal(command, dataRoot, fromStartup = false) {
  parcel.classList.remove('is-open');
  parcelTitle.textContent = '正在准备你的工作区';
  unpackingProgress({ stage: 'prepare' });
  showParcel();
  try {
    await setup.action(command, { dataRoot });
    unpackingProgress({ stage: 'ready' });
    parcel.classList.add('is-open');
    await Promise.all(lid.getAnimations().map(animation => animation.finished.catch(() => {})));
    await setup.action('continue');
  } catch (error) {
    if (fromStartup) {
      parcelTitle.textContent = '开箱暂未完成';
      stageLabel.textContent = '工作区暂时无法打开';
      stageDetail.textContent = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      parcelActions.replaceChildren(button('重试打开工作区', () => open(), true), button('工作区选项', () => {
        unpacking.hidden = true;
        welcome.hidden = false;
        showChoices();
      }));
      parcelActions.hidden = false;
      return;
    }
    unpacking.hidden = true;
    welcome.hidden = false;
    throw error;
  }
}

function chooseLocal() {
  say('在本机创建工作区', true);
  say('工作区会保存在你选的目录。新建时如果默认端口被占用，我会自动选一个空闲端口。关闭窗口后，服务可以继续运行。');
  form([field('工作区数据目录', 'dataRoot', { placeholder: workspace.defaultDataRoot || '使用默认目录' })],
    '创建或打开本机工作区', values => unpackLocal('local', values.dataRoot.trim() || undefined));
  buttons(button('返回选择', showChoices));
}

function chooseRemote() {
  say('连接已有工作区', true);
  say('请填写工作区的地址和访问令牌。你可以向工作区的部署者索取。');
  const fields = [field('工作区地址', 'address', { type: 'url', placeholder: 'https://你的工作区地址', value: workspace.mode === 'remote' ? workspace.origin : '' }),
    field('工作区访问令牌', 'token', { type: 'password' })];
  if (workspace.mode === 'local' && workspace.local?.owner === 'summon' && workspace.local.state === 'ready') {
    fields.push(field('切换时停止这个安装管理的本机服务', 'stopLocal', { type: 'checkbox' }));
  }
  form(fields, '连接工作区', async values => {
    await setup.action('remote', { address: values.address.trim(), token: values.token.trim(), stopLocal: values.stopLocal === 'on' });
  });
  buttons(button('返回选择', showChoices));
}

function showChoices() {
  controls.replaceChildren();
  buttons(button(workspace.local?.dataRoot ? '打开本机工作区' : '在本机创建工作区', chooseLocal, true),
    button('连接已有工作区', chooseRemote));
  if (workspace.mode === 'remote' || workspace.mode === 'local' && workspace.local?.state === 'ready') {
    buttons(button('回到当前工作区', () => setup.action('continue')));
  }
  if (workspace.mode === 'local') buttons(button('Codex 工作执行器', showCodex),
    button('Cloudflare Tunnel', () => showAccess('cloudflare')), button('Tailscale Serve', () => showAccess('tailscale')));
  if (workspace.mode === 'local' && workspace.local?.state === 'ready') buttons(button('复制工作区访问令牌', async () => {
    await setup.action('copy-access-token');
    status.textContent = '访问令牌已复制，可粘贴到另一台设备的安全输入框。';
  }));
}

async function showCodex() {
  const result = await setup.action('codex', { action: 'status' });
  const title = 'Codex 工作执行器';
  say(result.enabled ? 'Codex 已获得 WORK 执行授权。聊天继续用你选择的模型。' : '先打开使用默认权限的本机 Codex 会话。我们会核对它的权限，再接入 WORK 执行器。');
  const fields = [field('本机 Codex 会话 ID', 'callerThreadId', { placeholder: result.callerConfigured ? '已设置，留空可沿用' : '' })];
  if (result.platform === 'darwin') fields.push(field('Codex 工具套接字', 'toolsPipe'), field('Codex 会话 IPC 套接字', 'ipcPipe'));
  if (!result.enabled && result.status !== 'external') {
    form(fields, '保存本机端点', async values => {
      const saved = await setup.action('codex', { action: 'prepare', ...values });
      say(saved.callerConfigured && saved.socketsConfigured ? '本机端点已保存。现在可以确认接入。' : '请补齐会话 ID 和本机端点。');
      if (saved.callerConfigured && saved.socketsConfigured) {
        controls.replaceChildren();
        buttons(button('允许接入 Codex 执行器', () => connectCodex(true), true), button('返回', showChoices));
      }
    });
  } else {
    controls.replaceChildren();
    buttons(button(result.enabled ? '停用 Codex 执行器' : '允许接入 Codex 执行器', () => connectCodex(!result.enabled), true));
  }
  buttons(button('返回主 Bot 对话', () => setup.action('continue')), button('返回工作区选择', showChoices));
  document.querySelector('#title').textContent = title;
}

async function connectCodex(enabled) {
  await setup.action('codex-consent', { enabled });
  await showCodex();
}

const statusText = {
  missing: '部署机还没有安装所需组件。', 'needs-login': '请先在部署机登录 Tailscale。',
  'needs-https': '请先在 tailnet 启用 HTTPS。', 'needs-authorization': '需要在官方授权页确认 HTTPS，然后回到这里重试。',
  conflict: '所选端口已有其他映射或启用了 Funnel。请使用未占用的 HTTPS 端口。',
  configured: '检测到可复用的现有 Serve 映射。', available: '可以准备新的入口。',
  registered: '入口已登记。', reachable: '可以通过该地址访问这个工作区。',
  stopped: '本机连接器已停止。', unavailable: '暂时无法读取或修改配置，请检查组件、登录和本机权限。',
  'waiting-connector': '正在等待 cloudflared 连接到 Cloudflare。', 'connector-unavailable': 'cloudflared 启动失败，请检查版本和令牌。',
  'mapping-unconfirmed': '暂时无法确认 Serve 映射，请查询状态后再试。', revoked: '已撤销该入口的登记。',
};

function describe(result) {
  say((statusText[result.state] || '请检查当前接入状态。') + (result.origin ? '\n' + result.origin : '')
    + (result.reachable === false && result.registered ? '\n当前未能通过该地址访问这个工作区。请核对代理目标和网络。' : ''));
}

function accessLinks(provider, result) {
  if (result.docsUrl) {
    const link = document.createElement('a'); link.className = 'button';
    link.href = result.docsUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = '官方安装指引'; buttons(link);
  }
  if (result.authorizationAvailable) buttons(button('打开官方授权页', () => setup.action('authorize', { provider })));
}

async function showAccess(provider) {
  const result = await setup.action('access', { action: 'status', provider });
  document.querySelector('#title').textContent = provider === 'tailscale' ? 'Tailscale Serve' : 'Cloudflare Tunnel';
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
      describe(await setup.action('access', { action: 'revoke', provider, confirm: true }));
      await showAccess(provider);
    }, true), button('取消', () => showAccess(provider)));
  }));
  buttons(button('返回主 Bot 对话', () => setup.action('continue')), button('返回工作区选择', showChoices));
}

function confirmAccess(provider, plan) {
  say((plan.reuse ? '将复用现有映射。' : '请确认这个 HTTPS 入口。') + '\n' + plan.origin + ' → ' + plan.target);
  form(plan.owner === 'summon' && provider === 'cloudflare' ? [field('隧道令牌', 'token', {
    type: 'password', placeholder: plan.needsToken ? '粘贴已建隧道的令牌' : '留空沿用已保存的令牌',
  })] : [], '确认并应用', async values => {
    const result = await setup.action('access', { action: 'apply', provider, confirm: true, planId: plan.planId, token: values.token?.trim() });
    describe(result); accessLinks(provider, result);
    if (['registered', 'reachable'].includes(result.state)) {
      controls.replaceChildren();
      buttons(button('回到主 Bot 的引导', () => setup.action('continue'), true), button('查看接入设置', () => showAccess(provider)));
    }
  });
  buttons(button('返回', () => showAccess(provider)));
}

async function open() {
  const info = await setup.info();
  workspace = info.workspace; transcript.replaceChildren(); controls.replaceChildren();
  document.querySelector('#title').textContent = '你好，我是主 Bot。';
  if (info.section === 'unpacking') {
    const existing = workspace.existingDataRoot || (workspace.buildId !== workspace.installedBuildId && workspace.local?.dataRoot);
    if (existing) return chooseParcel(existing);
    return unpackLocal(workspace.mode === 'local' ? 'resume' : 'local', undefined, true);
  }
  unpacking.hidden = true;
  welcome.hidden = false;
  if (info.section === 'codex') await showCodex();
  else if (['cloudflare', 'tailscale'].includes(info.section)) await showAccess(info.section);
  else {
    say('欢迎来到 Summon Bot。你可以在这台电脑上创建自己的工作区，也可以连接一个已经运行的工作区。');
    if (workspace.origin) say('当前选择了' + (workspace.mode === 'local' ? '本机工作区。' : '远程工作区。') + '\n' + workspace.origin);
    showChoices();
  }
  status.textContent = info.error || '';
}

const avatars = window.SummonAvatars;
if (avatars) parcel.querySelector('.parcel-bot').innerHTML = avatars.render(avatars.defaults('bot-entry'), 144, { static: true });
setup.onProgress(progress => { if (!unpacking.hidden) unpackingProgress(progress); });
setup.onSetup(() => void perform(open));
void perform(open);
