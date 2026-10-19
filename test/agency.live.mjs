// Opt-in real social actions: persistent memory, knowledge, and chat-to-Codex delegation.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../src/server.mjs';

const dir = resolve('.relay/evidence', `agency-${Date.now()}`);
const cwd = join(dir, 'work');
await mkdir(cwd, { recursive: true });
const app = await startServer({ config: { port: 0, dataDir: dir, database: join(dir, 'relay.sqlite') } });
const report = { startedAt: new Date().toISOString(), checks: [] };
const api = async (path, body) => {
  const response = await fetch(app.url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
};
const waitFor = async (label, fn, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Timed out: ${label}`);
};
const record = (name, detail) => { report.checks.push({ name, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); };
try {
  const room = await api('/rooms', { name: '真实自主动作验证', kind: 'dm', members: ['user', 'bot-engineer'] });
  const send = content => api(`/rooms/${room.id}/messages`, { content, toBotId: 'bot-engineer' });
  await send('请现在使用 memory 动作，把这条专业经验保存为你的长期记忆：AGENCY-LIVE 验证必须区分真实调用与测试替身。来源为本轮开发验证，版本 v1。仅保存，不做其他动作。');
  const memory = await waitFor('model memory action', async () => (await api('/bots/bot-engineer/memories')).memories.find(m => m.content.includes('AGENCY-LIVE')));
  record('真实模型提取长期记忆', { id: memory.id, source: memory.source });
  await send('请使用 knowledge 动作创建共享条目：标题 AGENCY-LIVE 验证说明，内容为“这是开发验证输入，未代表真实项目验收”，knowledgeType 为 unverified，source 为本轮测试。只创建这一条。');
  const node = await waitFor('model knowledge action', async () => (await api('/state')).knowledge.nodes.find(n => n.title.includes('AGENCY-LIVE')));
  record('真实模型提交带来源知识', { id: node.id, type: node.type, source: node.source });
  await send(`现在明确授权你使用 work 动作委托 Codex 执行一项小工作。cwd 必须为 ${cwd}。目标：先调用 relay_consult 向 bot-components 询问一句话的验证记录建议；然后在当前目录写 agency-result.txt，第一行必须为 AGENCY_WORK_OK，下一行原样写同事答复。使用命令真实读取核对文件，报告实际结果。只修改这个目录、不提交不推送。不要用 dm 或 deep 代替工作，不需要再询问我；现在发出结构化 work 委托。`);
  const work = await waitFor('model work action', async () => (await api('/state')).works.find(w => w.roomId === room.id));
  assert.ok(work.sourceActionId, 'work should retain the model action that delegated it');
  record('真实聊天自主发起委托', { workId: work.id, sourceActionId: work.sourceActionId });
  await waitFor('work running', async () => ['running', 'waiting'].includes((await api(`/works/${work.id}`)).status));
  const startFast = Date.now();
  const fastMessage = await send('工作正在执行。请简短回复“我仍可处理快聊”，不创建新工作或其他动作。');
  const reply = await waitFor('fast chat during work', async () => (await api(`/rooms/${room.id}/messages`)).messages.find(m => m.senderId === 'bot-engineer' && m.replyTo === fastMessage.id && m.kind === 'message'));
  record('执行期间同一成员快聊', { elapsedMs: Date.now() - startFast, reply: reply.content, workStatusAtReply: (await api(`/works/${work.id}`)).status });
  const completed = await waitFor('work completion', async () => {
    const latest = await api(`/works/${work.id}`);
    if (['failed', 'cancelled', 'interrupted'].includes(latest.status)) throw new Error(`Work ${latest.status}: ${latest.error}`);
    return latest.status === 'completed' && latest;
  }, 300000);
  const file = await readFile(join(cwd, 'agency-result.txt'), 'utf8');
  assert.match(file, /AGENCY_WORK_OK/);
  const consultation = completed.events.find(event => event.type === 'consult_answer' && event.data?.source === 'bot');
  assert.ok(consultation?.data.answer, 'Must retain the actual peer answer');
  assert.equal(file.replaceAll('\r\n', '\n').trimEnd(), `AGENCY_WORK_OK\n${consultation.data.answer}`.trimEnd());
  const result = await waitFor('result returned to chat', async () => (await api(`/rooms/${room.id}/messages`)).messages.find(m => m.workId === work.id && m.kind === 'work'));
  record('真实工作完成并回传来源私聊', { workId: work.id, threadId: completed.threadId, file, returnedMessageId: result.id });
  report.completedAt = new Date().toISOString();
} catch (error) { report.error = error.message; console.error(error); process.exitCode = 1; }
finally {
  report.provider = app.provider.status;
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
  console.log(`Evidence: ${join(dir, 'report.json')}`);
}
