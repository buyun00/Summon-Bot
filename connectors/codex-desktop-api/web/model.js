export const GROUPS = ['服务', '对话查询', '对话操作', '实时与追踪'];
const metadata = {
  'GET /healthz': ['服务', '健康检查', '检查 API 进程是否在线。'],
  'GET /v1/capabilities': ['服务', '连接与能力', '查看桌面连接、协议版本和当前可用功能。'],
  'GET /v1/openapi.json': ['服务', 'OpenAPI 文档', '获取当前服务的完整接口定义。'],
  'GET /v1/account/usage': ['服务', '账户周额度', '读取桌面账户的周额度百分比、已用、剩余和重置时间。'],
  'GET /v1/projects': ['服务', '项目列表', '读取 Codex 已保存的项目及其 ID。'],
  'GET /v1/threads': ['对话查询', '对话列表', '读取最近对话和全部置顶对话。最多 50 条最近对话。'],
  'GET /v1/threads/archived': ['对话查询', '归档列表', '分页读取已经归档的对话。'],
  'GET /v1/threads/{threadId}': ['对话查询', '对话详情', '查看指定对话的元数据和最近回合摘要。'],
  'GET /v1/threads/{threadId}/messages': ['对话查询', '消息与输出', '分页读取消息和工具输出摘要；长输出可能截断。'],
  'GET /v1/threads/{threadId}/state': ['对话查询', '实时状态', '读取桌面当前运行对象；未加载的对话可能没有实时快照。'],
  'POST /v1/threads': ['对话操作', '创建对话', '创建真实桌面对话并发送初始消息。返回 ID 后可直接作为测试目标。'],
  'POST /v1/threads/{threadId}/messages': ['对话操作', '发送消息', '向指定对话发送消息。正在运行时，由桌面将消息加入当前任务。'],
  'PATCH /v1/threads/{threadId}': ['对话操作', '重命名', '修改本机对话在桌面中显示的名称。'],
  'POST /v1/threads/{threadId}/interrupt': ['对话操作', '中断回合', '仅停止 expectedTurnId 对应的当前回合。可先读取实时状态取得 ID。'],
  'POST /v1/threads/{threadId}/archive': ['对话操作', '归档对话', '将指定对话移入归档列表。'],
  'POST /v1/threads/{threadId}/unarchive': ['对话操作', '恢复对话', '将已归档对话恢复到桌面列表。'],
  'POST /v1/threads/{threadId}/read-state': ['对话操作', '已读状态', '将对话标记为已读或未读。'],
  'GET /v1/events': ['实时与追踪', 'SSE 实时事件', '订阅状态和输出。可指定对话，或留空查看当前监控范围。'],
  'GET /v1/operations/{key}': ['实时与追踪', '操作结果', '通过幂等键查询写操作，特别适用于超时后核对实际结果。'],
};
export function operationsFromSpec(spec) {
  return Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method)).map(([method, operation]) => {
    const id = `${method.toUpperCase()} ${path}`;
    const [group, title, description] = metadata[id] || ['服务', operation.summary || path, operation.description || ''];
    return { id, method: method.toUpperCase(), path, group, title, description, parameters: operation.parameters || [], bodySchema: operation.requestBody?.content?.['application/json']?.schema, stream: path === '/v1/events', mutation: method !== 'get' };
  })).sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}
export function defaultBody(operation, turnId = '') {
  if (operation.id === 'POST /v1/threads') return { title: 'API 网页测试', prompt: '这是 API 测试。请勿调用工具或修改文件，只回复：网页连接成功。', target: { type: 'projectless' } };
  if (operation.path.endsWith('/messages')) return { message: '这是追加消息测试。请勿调用工具或修改文件，只回复：追加消息成功。' };
  if (operation.path.endsWith('/interrupt')) return { expectedTurnId: turnId };
  if (operation.path.endsWith('/read-state')) return { read: true };
  if (operation.method === 'PATCH') return { title: 'API 网页测试 · 已重命名' };
  return {};
}
export function defaultValues(operation) {
  return Object.fromEntries(operation.parameters.map(parameter => [parameter.name, parameter.schema?.default != null ? String(parameter.schema.default) : '']));
}
export function buildRequest(operation, values, bodyText) {
  let path = operation.path;
  const query = new URLSearchParams(), headers = {};
  for (const parameter of operation.parameters) {
    let value = String(values[parameter.name] ?? '').trim();
    if (operation.stream && parameter.name === 'hostId' && !String(values.threadId || '').trim()) continue;
    if (!value) { if (parameter.required) throw new Error(`请填写 ${parameter.name}`); continue; }
    if (parameter.schema?.type === 'integer') {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || (parameter.schema.minimum != null && n < parameter.schema.minimum) || (parameter.schema.maximum != null && n > parameter.schema.maximum)) throw new Error(`${parameter.name} 必须是有效范围内的整数`);
    }
    if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    else if (parameter.in === 'query') query.set(parameter.name, value);
    else if (parameter.in === 'header') headers[parameter.name] = value;
  }
  let body;
  if (operation.bodySchema) {
    try { body = JSON.parse(bodyText); } catch { throw new Error('请求体不是有效 JSON，请检查逗号和引号。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象。');
  }
  return { url: `${path}${query.size ? `?${query}` : ''}`, method: operation.method, headers, ...(body ? { body } : {}) };
}
export function curlExample(request, origin) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const lines = [`curl${request.url.startsWith('/v1/events') ? ' -N' : ''} -X ${request.method} ${quote(origin + request.url)}`];
  for (const [name, value] of Object.entries(request.headers)) lines.push(`  -H ${quote(`${name}: ${value}`)}`);
  if (request.body) lines.push("  -H 'Content-Type: application/json'", `  --data-raw ${quote(JSON.stringify(request.body))}`);
  return lines.join(' \\\n');
}
export class SseDecoder {
  constructor() { this.buffer = ''; }
  push(text) {
    this.buffer += text; const events = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer); if (!match) break;
      const frame = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const lines = frame.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
      const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      let value; try { value = JSON.parse(data); } catch { value = { text: data }; }
      events.push({ id, type, value });
    }
    return events;
  }
}
