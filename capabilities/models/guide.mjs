import { modelChoices } from '../../bot/src/agent/connections.mjs';

export const option = (label, action, value = '') => ({ label, action, value });
export const looksLikeSecret = text => /\b(?:sk-|xai-)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|^(?=[A-Za-z0-9_+/=-]{32,}$)(?=.*[A-Za-z])(?=.*\d)/.test(text);

export async function guideReply(onboarding, input = {}) {
  const models = onboarding.models, action = String(input.action || 'hello'), value = String(input.value || '').trim();
  const script = onboarding.record().script, draft = { ...script?.draft };
  const choice = option;
  const reply = (phase, text, options = [], extra = {}) => ({ phase, text, options, draft, input: 'text', ...extra });
  const back = choice('换一种连接方式', 'back');
  const ready = entry => reply('ready', `${entry.name} · ${entry.model} 的配置已经保存。接下来发起第一条真实对话，由主 Bot 继续带你入门。`,
    [choice('开始，带我熟悉一下', 'handoff'), choice('换一个模型', 'choose')], { draft: {}, placeholder: '回复“开始”，或告诉我最想做的事…' });
  const select = async id => {
    await models.select(id);
    try { return handoffReply(await onboarding.handoff({})); }
    catch (error) { return handoffReply({ error: error.expose ? error.message : '聊天模型已保存，主 Bot 暂时无法开始对话。' }); }
  };
  const modelPrompt = () => {
    const catalog = modelChoices(draft.kind, draft.provider);
    const preferred = draft.model ? [catalog.find(entry => entry.id === draft.model) || { id: draft.model }, ...catalog.filter(entry => entry.id !== draft.model)] : catalog;
    return reply('model', '你想用哪个聊天模型？可以选择下面的模型，也可以输入模型 ID。', [...preferred.slice(0, 6).map(entry => choice(entry.id, 'model', entry.id)), back], { placeholder: '输入模型 ID…' });
  };
  const handoffReply = state => {
    if (state.status === 'guiding') return reply('complete', '', [], { roomId: state.roomId, input: 'none', draft: {} });
    if (state.status === 'starting') return reply('waiting', '我在等模型返回第一条回复。', [], { input: 'none', draft: {} });
    return reply('failed', state.error || '首条回复还没到。', [choice('重试首条对话', 'handoff'), choice('换一个模型', 'choose')], { input: 'none', draft: {} });
  };
  if (!['key', 'poll'].includes(action) && looksLikeSecret(value)) throw new Error('请在隐藏的 API Key 输入中填写密钥，不要发送到聊天里。');
  if (action === 'progress') {
    const state = onboarding.state();
    return state.status === 'starting' && !onboarding.kickoff(state.roomId, onboarding.record().kickoffId).latest && !onboarding.submitting
      ? handoffReply(await onboarding.handoff({})) : handoffReply(state);
  }
  if (action === 'hello') {
    const state = onboarding.state();
    if (state.status === 'starting' || state.status === 'guiding') return handoffReply(state);
    if (script?.phase === 'login') {
      const login = models.loginStatus(draft.id);
      const saved = (await models.snapshot()).connections.find(entry => entry.id === draft.id);
      if (login.status === 'completed' || saved?.configured) return modelPrompt();
      if (['starting', 'waiting'].includes(login.status)) return { ...script, login };
      return reply('choose', '授权已结束。可以重新授权，或改用 API Key。', [
        choice('重新授权订阅', 'authorize', draft.kind), choice('换一种连接方式', 'choose')
      ], { input: 'none', draft: {} });
    }
    if (script && !['choose', 'ready'].includes(script.phase)) return script;
    const snapshot = await models.snapshot(), active = snapshot.connections.find(entry => entry.active && entry.configured);
    if (active && state.status === 'failed') return handoffReply(state);
    if (active && state.status === 'paused') return reply('ready', '上次停在这里。接着聊吧？', [choice('继续新手引导', 'handoff'), choice('换一个模型', 'choose')], { draft: {} });
    if (active && state.status === 'pending') return handoffReply(await onboarding.handoff({}));
    if (active) return ready(active);
  }
  if (['hello', 'choose', 'back'].includes(action)) {
    if (action === 'back' && draft.id) models.cancelLogin(draft.id);
    const local = await models.localLogins(), snapshot = await models.snapshot(), found = local.sources.filter(entry => entry.available);
    return reply('choose', found.length ? `在运行 Summon Bot 的主机上找到了 ${found.map(entry => entry.name).join(' 和 ')} 登录。要直接导入吗？也可以用 API Key。`
      : '没有找到可导入的本机登录。我们可以用 API Key 接上模型，也可以授权 Codex 或 Grok 订阅。',
    [...found.map(entry => choice(`导入本机 ${entry.name} 登录`, 'import', entry.kind)),
      ...snapshot.connections.filter(entry => entry.configured).map(entry => choice(`使用 ${entry.name}`, 'use', entry.id)),
      choice('使用 API Key', 'api'), choice('登录 Codex 订阅', 'authorize', 'codex'), choice('登录 Grok 订阅', 'authorize', 'grok')], { draft: {}, input: 'none' });
  }
  if (action === 'api') {
    const snapshot = await models.snapshot();
    return reply('provider', '你用的是哪家的模型服务？', snapshot.presets.map(entry => choice(entry.name, 'provider', entry.id)), { draft: {}, input: 'none' });
  }
  if (action === 'provider') {
    const snapshot = await models.snapshot(), preset = snapshot.presets.find(entry => entry.id === value);
    if (!preset) throw new Error('请选择一个模型服务商');
    Object.assign(draft, { kind: 'api', id: `onboarding-api-${preset.id}`, name: preset.name, provider: preset.id, api: preset.api, baseUrl: preset.baseUrl, contextWindow: 128000, maxTokens: 8192 });
    return preset.baseUrl ? modelPrompt() : reply('endpoint', '把这个服务的 API 地址告诉我，例如 https://api.example.com/v1。', [back], { placeholder: '输入 API 地址…' });
  }
  if (action === 'endpoint') {
    let url; try { url = new URL(value); } catch { throw new Error('请填写有效的 API 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含密钥、查询参数或账号密码');
    draft.baseUrl = url.href.replace(/\/+$/, '');
    return reply('protocol', '这个服务使用哪种接口？一般的 OpenAI 兼容服务可以选择 Chat Completions。',
      [choice('Chat Completions', 'protocol', 'openai-completions'), choice('Responses', 'protocol', 'openai-responses'), choice('Anthropic Messages', 'protocol', 'anthropic-messages'), back], { input: 'none' });
  }
  if (action === 'protocol') {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(value)) throw new Error('请选择有效的模型协议');
    draft.api = value; return modelPrompt();
  }
  if (action === 'import') {
    const snapshot = await models.importLocal(value), entry = snapshot.connections.find(item => item.id === snapshot.importedId);
    Object.assign(draft, entry); return modelPrompt();
  }
  if (action === 'authorize') {
    if (!['codex', 'grok'].includes(value)) throw new Error('请选择 Codex 或 Grok');
    const id = `onboarding-${value}`, snapshot = await models.save({ id, kind: value, name: value === 'codex' ? 'Codex 订阅' : 'Grok 订阅' });
    Object.assign(draft, snapshot.connections.find(entry => entry.id === id));
    if (draft.configured) return modelPrompt();
    return reply('login', '在授权页面完成登录就好，我会在这里等你。', [back], { input: 'none', login: models.startLogin(id) });
  }
  if (action === 'poll') {
    const login = models.loginStatus(draft.id);
    if (login.status === 'completed') return modelPrompt();
    if (!['starting', 'waiting'].includes(login.status)) throw new Error(login.error || '授权已结束，请更换连接方式后重新登录');
    return reply('login', '', [back], { input: 'none', login });
  }
  if (action === 'model') {
    if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error('请填写有效的模型 ID');
    draft.model = value;
    const model = modelChoices(draft.kind, draft.provider).find(entry => entry.id === value);
    if (model?.contextWindow) draft.contextWindow = model.contextWindow;
    if (model?.maxTokens) draft.maxTokens = Math.min(8192, model.maxTokens);
    if (draft.kind !== 'api') { await models.save(draft); return select(draft.id); }
    return reply('key', '最后，粘贴这个服务的 API Key。输入会隐藏，只用于保存连接，不进入聊天或草稿。',
      [choice('这是无需 Key 的本地服务', 'no-key'), back], { input: 'password', placeholder: '粘贴 API Key…' });
  }
  if (['key', 'no-key'].includes(action)) {
    if (draft.kind !== 'api') throw new Error('请先选择 API 服务商和模型');
    if (action === 'key' && !value) throw new Error('请填写 API Key');
    await models.save({ ...draft, ...(action === 'key' ? { apiKey: value } : {}), allowNoKey: action === 'no-key' });
    return select(draft.id);
  }
  if (action === 'use') return select(value);
  if (action === 'handoff') return handoffReply(await onboarding.handoff({ message: value }));
  throw new Error('请选择下面的连接方式，或继续填写当前步骤');
}
