'use strict';
// Brand artwork: Lobe Icons 1.102.0 (MIT); bundled locally in icons/ai-brands.svg.
globalThis.SummonModelIcons = (() => {
  const names = {
    ai: 'AI', deepseek: 'DeepSeek', openai: 'OpenAI', codex: 'Codex', claude: 'Claude', anthropic: 'Anthropic',
    claudecode: 'Claude Code', grok: 'Grok', xai: 'xAI', gemini: 'Gemini', gemma: 'Gemma', google: 'Google',
    qwen: 'Qwen', kimi: 'Kimi', minimax: 'MiniMax', zai: 'Z.ai / GLM', chatglm: 'ChatGLM', doubao: '豆包',
    hunyuan: '腾讯混元', wenxin: '文心', stepfun: '阶跃星辰', yi: '零一万物', xiaomimimo: 'Xiaomi MiMo',
    mistral: 'Mistral', meta: 'Meta / Llama', perplexity: 'Perplexity', cohere: 'Cohere', groq: 'Groq',
    openrouter: 'OpenRouter', ollama: 'Ollama', githubcopilot: 'GitHub Copilot', cursor: 'Cursor', nvidia: 'NVIDIA',
    huggingface: 'Hugging Face', together: 'Together', fireworks: 'Fireworks', bedrock: 'Amazon Bedrock',
    azure: 'Azure', cloudflare: 'Cloudflare', bytedance: '字节跳动', baidu: '百度', tencent: '腾讯', aws: 'AWS', microsoft: 'Microsoft',
  };
  const aliases = {
    deepseek: 'deepseek', ds: 'deepseek', openai: 'openai', 'openai-codex': 'openai', codex: 'openai', chatgpt: 'openai',
    anthropic: 'claude', claude: 'claude', 'claude-code': 'claudecode', claudecode: 'claudecode', xai: 'grok', 'x-ai': 'grok', grok: 'grok',
    google: 'gemini', gemini: 'gemini', 'google-vertex': 'gemini', vertex: 'gemini', gemma: 'gemma',
    qwen: 'qwen', alibaba: 'qwen', dashscope: 'qwen', qianwen: 'qwen', bailian: 'qwen',
    moonshot: 'kimi', moonshotai: 'kimi', kimi: 'kimi', 'kimi-coding': 'kimi', minimax: 'minimax',
    zai: 'zai', 'z.ai': 'zai', zhipu: 'zai', bigmodel: 'zai', glm: 'zai', chatglm: 'chatglm',
    doubao: 'doubao', seed: 'doubao', volcengine: 'doubao', bytedance: 'bytedance', hunyuan: 'hunyuan', tencent: 'tencent',
    wenxin: 'wenxin', ernie: 'wenxin', baidu: 'baidu', stepfun: 'stepfun', step: 'stepfun', '01-ai': 'yi', yi: 'yi',
    xiaomi: 'xiaomimimo', mimo: 'xiaomimimo', xiaomimimo: 'xiaomimimo', mistral: 'mistral', mistralai: 'mistral',
    meta: 'meta', 'meta-llama': 'meta', llama: 'meta', perplexity: 'perplexity', cohere: 'cohere', groq: 'groq',
    openrouter: 'openrouter', ollama: 'ollama', 'github-copilot': 'githubcopilot', githubcopilot: 'githubcopilot', copilot: 'githubcopilot',
    cursor: 'cursor', nvidia: 'nvidia', nim: 'nvidia', huggingface: 'huggingface', together: 'together', togetherai: 'together',
    fireworks: 'fireworks', 'fireworks-ai': 'fireworks', bedrock: 'bedrock', 'amazon-bedrock': 'bedrock', azure: 'azure',
    'azure-openai': 'azure', cloudflare: 'cloudflare', 'cloudflare-workers-ai': 'cloudflare', aws: 'aws', microsoft: 'microsoft',
  };
  const models = [
    [/(?:^|[/:])deepseek(?:[-_.]|$)/, 'deepseek'],
    [/(?:^|[/:])(?:claude|haiku|sonnet|opus|fable)(?:[-_.]|$)/, 'claude'],
    [/(?:^|[/:])(?:gpt|chatgpt|o[134])(?:[-_.]|$)/, 'openai'],
    [/(?:^|[/:])gemini(?:[-_.]|$)/, 'gemini'], [/(?:^|[/:])gemma(?:[-_.\d]|$)/, 'gemma'],
    [/(?:^|[/:])grok(?:[-_.]|$)/, 'grok'], [/(?:^|[/:])(?:qwen|qwq|qvq)(?:[-_.\d]|$)/, 'qwen'],
    [/(?:^|[/:])(?:kimi|moonshot)(?:[-_.]|$)/, 'kimi'], [/(?:^|[/:])minimax(?:[-_.]|$)/, 'minimax'],
    [/(?:^|[/:])(?:glm|chatglm)(?:[-_.\d]|$)/, 'zai'], [/(?:^|[/:])(?:doubao|seed)(?:[-_.]|$)/, 'doubao'],
    [/(?:^|[/:])hunyuan(?:[-_.]|$)/, 'hunyuan'], [/(?:^|[/:])(?:ernie|wenxin)(?:[-_.]|$)/, 'wenxin'],
    [/(?:^|[/:])(?:step|stepfun)(?:[-_.\d]|$)/, 'stepfun'], [/(?:^|[/:])yi(?:[-_.]|$)/, 'yi'],
    [/(?:^|[/:])mimo(?:[-_.]|$)/, 'xiaomimimo'],
    [/(?:^|[/:])(?:mistral|mixtral|codestral|devstral|magistral|ministral)(?:[-_.]|$)/, 'mistral'],
    [/(?:^|[/:])(?:llama|meta-llama)(?:[-_.\d]|$)/, 'meta'],
    [/(?:^|[/:])(?:sonar|perplexity)(?:[-_.]|$)/, 'perplexity'], [/(?:^|[/:])(?:cohere|command)(?:[-_.]|$)/, 'cohere'],
  ];
  const hosts = [
    ['deepseek.com', 'deepseek'], ['openai.com', 'openai'], ['chatgpt.com', 'openai'], ['anthropic.com', 'claude'],
    ['x.ai', 'grok'], ['grok.com', 'grok'], ['googleapis.com', 'gemini'], ['dashscope.aliyuncs.com', 'qwen'],
    ['moonshot.ai', 'kimi'], ['moonshot.cn', 'kimi'], ['kimi.com', 'kimi'], ['minimax.io', 'minimax'], ['minimaxi.com', 'minimax'],
    ['bigmodel.cn', 'zai'], ['z.ai', 'zai'], ['volces.com', 'doubao'], ['stepfun.com', 'stepfun'],
    ['xiaomimimo.com', 'xiaomimimo'], ['mistral.ai', 'mistral'], ['perplexity.ai', 'perplexity'], ['cohere.com', 'cohere'],
    ['groq.com', 'groq'], ['openrouter.ai', 'openrouter'], ['ollama.com', 'ollama'], ['nvidia.com', 'nvidia'],
    ['huggingface.co', 'huggingface'], ['together.xyz', 'together'], ['together.ai', 'together'], ['fireworks.ai', 'fireworks'],
    ['openai.azure.com', 'azure'], ['cloudflare.com', 'cloudflare'],
  ];
  function brand(item = {}) {
    if (item.role === 'executor') {
      if (/codex/i.test(`${item.kind || ''} ${item.id || ''}`)) return 'codex';
      if (/claude/i.test(`${item.kind || ''} ${item.id || ''}`)) return 'claudecode';
    }
    const model = String(item.model || '').trim().toLowerCase();
    for (const [pattern, id] of models) if (pattern.test(model)) return id;
    for (const value of [item.provider, item.kind]) if (aliases[String(value || '').toLowerCase()]) return aliases[String(value).toLowerCase()];
    let hostname = ''; try { hostname = new URL(item.baseUrl).hostname.toLowerCase(); } catch {}
    for (const [host, id] of hosts) if (hostname === host || hostname.endsWith(`.${host}`)) return id;
    return 'ai';
  }
  function svg(item, size = 24) {
    return `<svg class="model-brand-icon" width="${Number(size) || 24}" height="${Number(size) || 24}" viewBox="0 0 24 24" fill-rule="evenodd" aria-hidden="true" focusable="false"><use href="/icons/ai-brands.svg#ai-${brand(item)}"></use></svg>`;
  }
  return { brand, svg, name: item => names[brand(item)], count: Object.keys(names).length - 1 };
})();
