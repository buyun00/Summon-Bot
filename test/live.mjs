// Opt-in real-provider integration check. Uses an isolated database, real Flash, and optional real Codex.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../src/server.mjs';

const runDir = resolve('.relay', 'evidence', `live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(runDir, { recursive: true });
const app = await startServer({ config: { port: 0, dataDir: runDir, database: join(runDir, 'relay.sqlite') } });
const report = { startedAt: new Date().toISOString(), source: 'real DeepSeek Flash and HTTP APIs', checks: [], runDir };
const check = (name, detail) => { report.checks.push({ name, detail, at: new Date().toISOString() }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); };
const api = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
  const response = await fetch(app.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result;
};
const until = async (label, fn, timeout = 120000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} timed out`);
};

try {
  const state = await api('/state');
  assert.equal(state.provider.model, 'deepseek-flash');
  assert.equal(state.provider.configured, true);
  const dm = await api('/rooms', { name: '真实验证 · 工程私聊', kind: 'dm', members: ['user', 'bot-engineer'] });
  await api(`/rooms/${dm.id}/messages`, { content: '这是真实连通性测试。请简短说明你的职责，不调用任何动作。', toBotId: 'bot-engineer', clientId: 'live-fast-one' });
  const first = await until('Flash reply', async () => (await api(`/rooms/${dm.id}/messages`)).messages.find(m => m.senderId === 'bot-engineer' && m.kind !== 'error'));
  check('真实私聊回复', { roomId: dm.id, messageId: first.id, reply: first.content });

  const nodeA = await api('/knowledge/nodes', { title: '真实验证需求', content: '本地运行，保持可恢复。', type: 'fact', source: '本轮集成测试输入', version: 'v1' });
  const nodeB = await api('/knowledge/nodes', { title: '真实验证组件', content: '使用 SQLite。', type: 'fact', source: 'src/store.mjs', version: 'v1' });
  await api('/knowledge/edges', { from: nodeA.id, to: nodeB.id, relation: 'uses', source: '本轮显式测试关系' });
  const graph = await api(`/knowledge/graph?id=${nodeA.id}&depth=2`);
  assert.ok(JSON.stringify(graph).includes(nodeB.id));
  const revised = await api(`/knowledge/nodes/${nodeB.id}`, { content: '使用 SQLite WAL 模式。', version: 'v2', source: '本轮修订输入' }, 'PATCH');
  assert.ok(revised.history?.length);
  await api(`/bots/bot-engineer/memories`, { content: '真实测试标识 RELAY-LIVE：本地验证报告必须区分真实调用和测试替身。', category: 'professional', source: '测试输入', version: 'v1' });
  check('知识关联与修订', { nodes: [nodeA.id, nodeB.id], historyEntries: revised.history.length });

  const before = (await api('/state')).rooms.length;
  const consultation = await api(`/rooms/${dm.id}/messages`, { content: '请现在使用 dm 动作联系 bot-components，询问它对 SQLite 知识来源记录的建议，收回其建议后简短回复。不要创建工作或深聊。', toBotId: 'bot-engineer' });
  const colleagueRoom = await until('Bot DM', async () => {
    const now = await api('/state');
    return now.rooms.find(r => r.kind === 'dm' && r.members.includes('bot-engineer') && r.members.includes('bot-components') && r.id !== dm.id);
  });
  const peerRequest = await until('Exact colleague request', async () => (await api(`/rooms/${colleagueRoom.id}/messages`)).messages.find(m => m.senderId === 'bot-engineer' && m.returnTo?.messageId === consultation.id));
  const peerReply = await until('Colleague reply', async () => (await api(`/rooms/${colleagueRoom.id}/messages`)).messages.find(m => m.senderId === 'bot-components' && m.replyTo === peerRequest.id && m.kind === 'message'));
  const returnedReply = await until('Colleague answer returned to the user', async () => (await api(`/rooms/${dm.id}/messages`)).messages.find(m => m.peerReplyId === peerReply.id && m.senderId === 'bot-engineer'));
  check('真实 Bot 间主动私聊并回传用户', { roomId: colleagueRoom.id, reply: peerReply.content, returnedReply: returnedReply.content, returnedMessageId: returnedReply.id, roomCountBefore: before });

  const deep = await api('/rooms', { name: '真实验证 · 知识方案', kind: 'deep', members: ['bot-engineer', 'bot-components'], goal: '用很短的讨论比较 SQLite 中知识来源与版本的最小记录方案。最多两轮，不需要外部工作。结论必须说明这是方案建议、未验证长期稳定性。', originRoomId: dm.id, rounds: 1 });
  const startedFast = Date.now();
  const fastMessage = await api(`/rooms/${dm.id}/messages`, { content: '深聊正在进行；请立即用一句话回复：快聊仍可独立处理。不要调用动作。', toBotId: 'bot-engineer' });
  const concurrent = await until('Concurrent fast reply', async () => (await api(`/rooms/${dm.id}/messages`)).messages.find(m => m.senderId === 'bot-engineer' && m.replyTo === fastMessage.id && m.kind === 'message'));
  check('深聊期间真实快聊', { elapsedMs: Date.now() - startedFast, reply: concurrent.content, deepRoomId: deep.id });
  const ended = await until('Deep conclusion', async () => (await api('/state')).rooms.find(r => r.id === deep.id && r.status === 'concluded'), 240000);
  const conclusion = (await api('/state')).knowledge.nodes.find(n => n.id === ended.conclusionId);
  assert.ok(conclusion?.content);
  check('真实深聊产出', { roomId: ended.id, summary: conclusion.content, conclusionId: ended.conclusionId });

  const qaRoom = await api('/rooms', { name: '真实验证 · 质量职责', kind: 'dm', members: ['user', 'bot-qa'] });
  const routine = await api('/routines', { name: '一次真实职责验证', botId: 'bot-qa', roomId: qaRoom.id, instruction: '这是一条定时职责验证，请简短回复已检查本轮职责，不调用动作，不编造其他验证。', intervalSeconds: 3600, nextRunAt: new Date(Date.now() - 1000).toISOString(), enabled: true });
  await until('Routine run', async () => (await api('/state')).routines.find(r => r.id === routine.id && r.lastRunAt));
  await api(`/routines/${routine.id}`, { enabled: false }, 'PATCH');
  await api('/events', { type: 'test-evidence', content: '真实事件唤醒验证：只确认收到该测试事件，不做外部工作。', botId: 'bot-qa', roomId: qaRoom.id });
  const qaReply = await until('Event or routine reply', async () => (await api(`/rooms/${qaRoom.id}/messages`)).messages.find(m => m.senderId === 'bot-qa' && m.kind !== 'error'));
  check('持久职责与事件唤醒', { routineId: routine.id, reply: qaReply.content });

  if (process.argv.includes('--with-codex')) {
    const cwd = join(runDir, 'work');
    await mkdir(cwd, { recursive: true });
    const work = await api('/works', { botId: 'bot-engineer', roomId: dm.id, cwd,
      goal: '这是 Relay 真实联动验证。先调用 relay_consult，targetBotId 为 bot-components，询问：请给出一条不超过20字的 SQLite 来源记录建议。收到真实答复后，在当前目录创建 relay-live-result.txt，正文为 RELAY_LIVE_OK 换行后写入同事答复。使用命令实际读取该文件核对，然后报告实际文件与读取结果。不要修改其他目录，不提交不推送。',
      constraints: '只写当前测试目录；必须实际调用 relay_consult，不能自己模拟同事答复。', inputRefs: [] });
    const result = await until('Real Codex work', async () => {
      const value = await api(`/works/${work.id}`);
      if (['failed', 'cancelled', 'interrupted'].includes(value.status)) throw new Error(`Codex ${value.status}: ${value.error}`);
      return value.status === 'completed' && value;
    }, 300000);
    const output = await readFile(join(cwd, 'relay-live-result.txt'), 'utf8');
    assert.match(output, /RELAY_LIVE_OK/);
    check('真实 Codex 与 Flash 中途咨询', { workId: work.id, threadId: result.threadId, status: result.status, output, events: result.events.map(e => e.type) });
  }

  report.provider = (await api('/state')).provider;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.provider = app.provider.status;
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
  console.log(`Evidence: ${join(runDir, 'report.json')}`);
}
