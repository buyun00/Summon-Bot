import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SocialRuntime } from '../src/social.mjs';

// These are program-logic tests. All model responses below are explicit test doubles.
const response = value => ({ content: typeof value === 'string' ? value : JSON.stringify(value), usage: { total_tokens: 10 }, model: 'test-double' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await pause(5); }
  throw new Error(`Timed out: ${label}`);
}
async function idle(runtime) {
  await until(() => runtime.running.size === 0 && !runtime.store.list('jobs').some(job => job.status === 'queued'), 'runtime idle');
}
function fixture(t, complete = async () => response({ reply: '测试替身回复', actions: [] }), extra = {}) {
  const store = new Store(':memory:');
  const calls = [];
  const social = new SocialRuntime({ store, provider: { complete: async input => { calls.push(input); return complete(input); } }, ...extra });
  social.start();
  t.after(async () => { await social.stop(); store.close(); });
  return { store, social, calls };
}
const userDm = social => social.createRoom({ kind: 'dm', members: ['user', 'bot-engineer'], name: '工程私聊' });

test('avatar edits preserve profile fields, reject unsafe values, and stay out of model prompts', async t => {
  const { social, store, calls } = fixture(t);
  const bot = social.createBot({ name: '新伙伴', avatar: { shape: 'star4', color: '#8f59f9' } });
  assert.equal(bot.role, '项目协作');
  assert.deepEqual(bot.avatar, { shape: 'star4', color: '#8F59F9', image: '' });
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  social.updateBot(bot.id, { avatar: { image } });
  assert.equal(store.get('bots', bot.id).avatar.shape, 'star4');
  assert.equal(store.get('bots', bot.id).avatar.image, image);
  for (const avatar of [{ shape: 'invalid' }, { color: 'red;display:none' }, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }, { image: 'https://example.com/tracker.png' }]) {
    assert.throws(() => social.updateBot(bot.id, { name: 'must not change', avatar }));
  }
  assert.equal(store.get('bots', bot.id).name, '新伙伴');
  const room = social.createRoom({ kind: 'dm', members: ['user', bot.id] });
  social.postMessage(room.id, { content: '查看模型身份上下文' });
  await idle(social);
  assert.equal(JSON.parse(calls[0].messages[1].content).bot.role, '项目协作');
  assert.ok(!JSON.stringify(calls[0]).includes('data:image/'));
  assert.equal(JSON.parse(calls[0].messages[1].content).bot.avatar, undefined);
  assert.equal(social.updateBot(bot.id, { avatar: { image: null, color: '#F93498' } }).avatar.image, '');
});

test('group membership editing retains history and direct conversations keep their participants', async t => {
  const { social } = fixture(t);
  const room = social.createRoom({ name: '原群', members: ['user', 'bot-engineer'] });
  const original = social.appendMessage(room.id, { content: '已有历史' }, 'user');
  const updated = await social.handle('PATCH', `/api/rooms/${room.id}`, { name: '新群名', members: ['user', 'bot-qa', 'bot-qa'], goal: '验证目标' });
  assert.deepEqual(updated.members, ['user', 'bot-qa']);
  assert.equal(updated.name, '新群名');
  assert.equal(updated.goal, '验证目标');
  assert.deepEqual(social.roomMessages(room.id).map(message => message.id), [original.id]);
  assert.throws(() => social.updateRoom(room.id, { members: ['user'] }));
  assert.throws(() => social.updateRoom(room.id, { members: ['user', 'missing'] }));
  assert.throws(() => social.updateRoom(userDm(social).id, { members: ['user', 'bot-qa'] }));
});

test('conversation previews and handoff activity use the actual linked messages', t => {
  const { social, store } = fixture(t);
  const origin = userDm(social);
  const peer = social.createRoom({ kind: 'dm', members: ['bot-engineer', 'bot-components'] });
  const request = social.appendMessage(peer.id, { content: '咨询', toBotId: 'bot-components', returnTo: { roomId: origin.id, botId: 'bot-engineer', messageId: 'source' } }, 'bot-engineer');
  const reply = social.appendMessage(peer.id, { content: '实际同事答复', replyTo: request.id }, 'bot-components');
  const returned = social.appendMessage(origin.id, { content: '回到用户', peerReplyId: reply.id }, 'bot-engineer');
  const state = social.state();
  assert.equal(state.rooms.find(room => room.id === origin.id).lastMessage.id, returned.id);
  assert.equal(state.rooms.find(room => room.id === peer.id).lastMessage.id, reply.id);
  assert.equal(state.activity.find(message => message.id === reply.id).senderId, 'bot-components');
  assert.equal(state.activity.find(message => message.id === request.id).returnTo.roomId, origin.id);
  assert.equal(store.get('rooms', origin.id).lastMessage, undefined);
});

test('deep discussion edits keep active and concluded evidence tied to its original goal and members', t => {
  const { social, store } = fixture(t);
  const room = social.createRoom({ kind: 'deep', members: ['bot-engineer'] });
  social.updateRoom(room.id, { goal: '原讨论目标' });
  store.save('jobs', { id: 'held-deep-edit-test', roomId: room.id, status: 'queued', lane: 'deep' });
  assert.throws(() => social.updateRoom(room.id, { goal: '另一个目标' }), /进行中/);
  assert.throws(() => social.updateRoom(room.id, { members: ['bot-qa'] }), /进行中/);
  social.updateRoom(room.id, { name: '可修正名称', goal: '原讨论目标', members: ['bot-engineer'] });
  store.save('jobs', { id: 'held-deep-edit-test', status: 'completed' });
  store.save('rooms', { id: room.id, status: 'concluded', conclusionId: 'preserved-conclusion' });
  assert.throws(() => social.updateRoom(room.id, { goal: '新目标' }), /已结束/);
  assert.throws(() => social.updateRoom(room.id, { members: ['bot-qa'] }), /已结束/);
  const updated = social.updateRoom(room.id, { name: '整理后的名称' });
  assert.equal(updated.goal, '原讨论目标');
  assert.equal(updated.conclusionId, 'preserved-conclusion');
  assert.deepEqual(updated.members, ['bot-engineer']);
});

test('SQLite persists merged records, ordering, and rolls back a failed transaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-store-test-'));
  const file = join(directory, 'data.sqlite');
  let store = new Store(file);
  try {
    const first = store.save('nodes', { id: 'first', title: 'before', content: 'kept' });
    store.save('nodes', { id: 'second', title: 'second' });
    const updated = store.save('nodes', { id: first.id, title: 'after' });
    assert.equal(updated.content, 'kept');
    assert.equal(updated.createdAt, first.createdAt);
    assert.throws(() => store.transaction(() => { store.save('nodes', { id: 'rolled-back' }); throw new Error('rollback'); }));
    assert.equal(store.get('nodes', 'rolled-back'), undefined);
    store.close();
    store = new Store(file);
    assert.deepEqual(store.list('nodes').map(node => node.id), ['first', 'second']);
    assert.equal(store.get('nodes', first.id).title, 'after');
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('mentions target one member, client IDs deduplicate, and paused members remain silent', async t => {
  const { social, store, calls } = fixture(t);
  const original = social.postMessage('room-lobby', { content: '@质量伙伴 请检查这个要求', clientId: 'one' });
  const repeated = social.postMessage('room-lobby', { content: '@质量伙伴 请检查这个要求', clientId: 'one' });
  assert.equal(original.id, repeated.id);
  await idle(social);
  assert.equal(calls.length, 1);
  assert.equal(store.list('jobs')[0].botId, 'bot-qa');
  assert.equal(store.list('messages').filter(message => message.senderId === 'user').length, 1);
  social.updateBot('bot-qa', { status: 'paused' });
  social.postMessage('room-lobby', { content: '定向消息', toBotId: 'bot-qa' });
  await idle(social);
  assert.equal(calls.length, 1);
  const bot = social.updateBot('bot-engineer', { skills: ['读取 API 文档'], executor: 'codex' });
  assert.deepEqual(bot.skills, ['读取 API 文档']);
  assert.equal(bot.model, 'deepseek-flash');
});

test('slow deep discussion does not occupy fast slots and produces sourced conclusions', async t => {
  let releaseDeep;
  const deepGate = new Promise(resolve => { releaseDeep = resolve; });
  let held = false;
  const { social, store, calls } = fixture(t, async input => {
    if (input.messages[0].content.includes('平级讨论的记录者')) return response({ title: '测试结论', content: '这是测试替身方案，尚未进行真实验证。', status: 'unverified' });
    if (input.deep && !held) { held = true; await deepGate; }
    return response({ reply: input.deep ? '测试深聊贡献' : '测试快聊仍能处理', actions: [] });
  });
  const dm = userDm(social);
  const deep = social.createRoom({ kind: 'deep', members: ['bot-components'], name: '方案', rounds: 1, goal: '比较方案', originRoomId: dm.id });
  await until(() => held, 'deep started');
  social.postMessage(dm.id, { content: '快聊响应' });
  await until(() => social.roomMessages(dm.id).some(message => message.content === '测试快聊仍能处理'), 'fast reply');
  assert.equal(store.get('rooms', deep.id).status, 'active');
  assert.ok(calls.some(input => input.deep) && calls.some(input => !input.deep));
  releaseDeep();
  await idle(social);
  const ended = store.get('rooms', deep.id);
  assert.equal(ended.status, 'concluded');
  const node = store.get('nodes', ended.conclusionId);
  assert.equal(node.source, `room:${deep.id}`);
  assert.equal(node.type, 'unverified');
  assert.ok(social.roomMessages(dm.id).some(message => message.kind === 'summary' && message.content.includes(deep.id)));
});

test('Bot DM answers return to the original user conversation and autonomous messages remain bounded', async t => {
  const { social, store, calls } = fixture(t, async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.dmResult) return response({ reply: `同事答复：${data.dmResult.answer.content}`, actions: [] });
    if (data.bot.id === 'bot-engineer' && data.trigger.senderId === 'user') return response({ reply: '', actions: [{ type: 'dm', targetBotId: 'bot-components', message: '请回答组件问题' }] });
    if (data.bot.id === 'bot-components') return response({ reply: '测试组件答复', actions: [] });
    return response({ pass: true, reply: '', actions: [] });
  });
  const dm = userDm(social);
  const request = social.postMessage(dm.id, { content: '请联系组件同事' });
  await idle(social);
  const peer = store.list('rooms').find(room => room.kind === 'dm' && room.members.includes('bot-components'));
  assert.ok(peer);
  assert.ok(social.roomMessages(peer.id).some(message => message.senderId === 'bot-components' && message.content === '测试组件答复'));
  const returned = social.roomMessages(dm.id).find(message => message.peerReplyId);
  assert.equal(returned.content, '同事答复：测试组件答复');
  assert.equal(returned.replyTo, request.id);
  assert.equal(returned.senderId, 'bot-engineer');
  assert.equal(returned.rootId, request.id);
  assert.equal(social.roomMessages(peer.id).length, 2, 'no thank-you loop in the colleague DM');
  assert.ok(store.list('jobs').some(job => job.type === 'dm_result' && job.roomId === dm.id && job.status === 'completed'));
  assert.equal(calls.length, 3);

  social.provider.complete = async input => {
    const data = JSON.parse(input.messages[1].content);
    return response({ reply: '', actions: [{ type: 'dm', targetBotId: data.bot.id === 'bot-engineer' ? 'bot-qa' : 'bot-engineer', message: '测试重复链' }] });
  };
  const root = social.postMessage(dm.id, { content: '启动有限链测试' });
  await idle(social);
  const chain = store.list('jobs').filter(job => job.rootId === root.id);
  assert.equal(chain.length, 4);
  assert.equal(chain.at(-1).status, 'failed');
  assert.match(chain.at(-1).error, /跳数上限/);
  assert.ok(store.list('messages').filter(message => message.rootId === root.id).every(message => message.hop <= 4));
});

test('reused colleague DM keeps interleaved requests tied to their own source rooms', async t => {
  const { social, store, calls } = fixture(t, async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.dmResult) return response({ reply: `转达 ${data.dmResult.answer.content}`, actions: [] });
    if (data.bot.id === 'bot-engineer') return response({ actions: [{ type: 'dm', targetBotId: 'bot-components', message: data.trigger.content }] });
    return response({ reply: `答复 ${data.trigger.content}`, actions: [] });
  });
  const roomA = userDm(social);
  const roomB = social.createRoom({ name: '另一来源', kind: 'group', members: ['user', 'bot-engineer'] });
  const requestA = social.postMessage(roomA.id, { content: 'ONLY_SOURCE_A' });
  const requestB = social.postMessage(roomB.id, { content: 'ONLY_SOURCE_B' });
  await idle(social);
  const peerRooms = store.list('rooms').filter(room => room.members.includes('bot-components') && room.kind === 'dm');
  assert.equal(peerRooms.length, 1);
  for (const [room, request, own, other] of [[roomA, requestA, 'ONLY_SOURCE_A', 'ONLY_SOURCE_B'], [roomB, requestB, 'ONLY_SOURCE_B', 'ONLY_SOURCE_A']]) {
    const returned = social.roomMessages(room.id).filter(message => message.peerReplyId);
    assert.equal(returned.length, 1);
    assert.equal(returned[0].replyTo, request.id);
    assert.match(returned[0].content, new RegExp(own));
    assert.doesNotMatch(returned[0].content, new RegExp(other));
    const resultCall = calls.map(call => JSON.parse(call.messages[1].content)).find(data => data.dmResult && data.trigger.id === request.id);
    assert.doesNotMatch(JSON.stringify(resultCall.dmResult), new RegExp(other));
  }
});

test('nested colleague answers return along each request without restarting an automatic conversation', async t => {
  const { social, store } = fixture(t, async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.dmResult) return response({ reply: `${data.bot.id} 转达 ${data.dmResult.answer.content}`, actions: [] });
    if (data.bot.id === 'bot-engineer') return response({ actions: [{ type: 'dm', targetBotId: 'bot-components', message: '请核实来源' }] });
    if (data.bot.id === 'bot-components') return response({ actions: [{ type: 'dm', targetBotId: 'bot-qa', message: '请提供验证结论' }] });
    return response({ reply: '真实来源应单独记录；这是测试替身结论', actions: [] });
  });
  const room = userDm(social);
  const request = social.postMessage(room.id, { content: '请联系同事核实' });
  await idle(social);
  const returned = social.roomMessages(room.id).find(message => message.peerReplyId);
  assert.match(returned.content, /bot-engineer 转达 bot-components 转达/);
  assert.equal(returned.replyTo, request.id);
  assert.equal(store.list('jobs').length, 5);
  assert.ok(store.list('jobs').every(job => job.rootId === request.id && job.status === 'completed'));
  assert.ok(store.list('messages').every(message => message.hop <= 4));
});

test('restart recovers a saved colleague reply once and an empty summary quotes that exact answer', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const provider = { complete: async () => { calls++; return response({ pass: true, reply: '', actions: [] }); } };
  const social = new SocialRuntime({ store, provider });
  const room = userDm(social);
  const origin = social.appendMessage(room.id, { content: '用户原问题' }, 'user');
  const peer = social.createRoom({ kind: 'dm', members: ['bot-engineer', 'bot-components'] });
  const question = social.appendMessage(peer.id, { content: '同事咨询', toBotId: 'bot-components', rootId: origin.id, hop: 1,
    returnTo: { roomId: room.id, messageId: origin.id, botId: 'bot-engineer' } }, 'bot-engineer');
  const reply = social.appendMessage(peer.id, { content: '唯一的同事原文', replyTo: question.id, rootId: origin.id, hop: 2 }, 'bot-components');
  try {
    social.start();
    await idle(social);
    const returned = social.roomMessages(room.id).find(message => message.peerReplyId);
    assert.equal(returned.content, '组件伙伴已回复（原文）：\n唯一的同事原文');
    assert.equal(returned.peerReplyId, reply.id);
    assert.equal(store.list('jobs').length, 1);
    await social.stop();
    social.start();
    social.queueDmReturn(reply);
    await idle(social);
    assert.equal(calls, 1);
    assert.equal(social.roomMessages(room.id).length, 2);
  } finally { await social.stop(); store.close(); }
});

test('failed return reports the error in the source and retries without asking the colleague twice', async t => {
  let failReturn = true;
  let peerCalls = 0;
  const { social, store } = fixture(t, async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.dmResult) {
      if (failReturn) throw new Error('测试回传模型中断');
      return response({ reply: '现在转达同事已收到的答复', actions: [] });
    }
    if (data.bot.id === 'bot-engineer') return response({ actions: [{ type: 'dm', targetBotId: 'bot-components', message: '询问一次' }] });
    peerCalls++;
    return response({ reply: '已收到的答复', actions: [] });
  });
  const room = userDm(social);
  social.postMessage(room.id, { content: '请问同事后回复我' });
  await idle(social);
  const failed = store.list('jobs').find(job => job.type === 'dm_result');
  assert.equal(failed.status, 'failed');
  assert.ok(social.roomMessages(room.id).some(message => message.kind === 'error' && /测试回传模型中断/.test(message.content)));
  await social.stop();
  social.start();
  await idle(social);
  assert.equal(store.get('jobs', failed.id).status, 'failed', 'restart must not implicitly retry failed returns');
  failReturn = false;
  await social.handle('POST', `/api/jobs/${encodeURIComponent(failed.id)}/retry`, {});
  await idle(social);
  assert.equal(peerCalls, 1);
  assert.equal(social.roomMessages(room.id).filter(message => message.peerReplyId).length, 1);
});

test('failed actions are reported as failure and retry does not repeat already applied actions', async t => {
  let attempts = 0;
  let store;
  const fx = fixture(t, async () => response({ reply: '我会记录并委托。', actions: [
    { type: 'memory', content: '长期约束', source: '测试来源' }, { type: 'work', goal: '测试工作' }
  ] }), { createWork: input => { attempts++; if (attempts === 1) throw new Error('测试执行器暂不可用'); return store.save('works', { ...input, status: 'queued' }); } });
  ({ store } = fx);
  const dm = userDm(fx.social);
  fx.social.postMessage(dm.id, { content: '实际实施目标' });
  await idle(fx.social);
  const failed = store.list('jobs')[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /执行器暂不可用/);
  assert.equal(store.list('memories').length, 1);
  assert.equal(store.list('works').length, 0);
  await fx.social.handle('POST', `/api/jobs/${encodeURIComponent(failed.id)}/retry`, {});
  await idle(fx.social);
  assert.equal(store.get('jobs', failed.id).status, 'completed');
  assert.equal(store.list('memories').length, 1);
  assert.equal(store.list('memories')[0].history.length, 0);
  assert.equal(store.list('works').length, 1);
  assert.equal(fx.calls.length, 1, 'retry uses saved structured response, not a second arbitrary model plan');
  assert.equal(socialReplies(fx.social, dm.id).length, 1);
});
function socialReplies(social, roomId) { return social.roomMessages(roomId).filter(message => message.senderId === 'bot-engineer'); }

test('structured Bot memory, knowledge, and work actions survive a lost completion marker without reapplying', async t => {
  let workCreates = 0;
  let store;
  const fx = fixture(t, async () => response({ reply: '以下是测试替身自主动作。', actions: [
    { type: 'memory', content: '测试专业经验', category: 'professional' },
    { type: 'knowledge', title: '测试来源条目', content: '待核查方案', knowledgeType: 'hypothesis' },
    { type: 'work', goal: '测试委托', constraints: '仅由测试执行器记录', inputRefs: ['test-ref'] }
  ] }), { createWork: input => { workCreates++; return store.save('works', { ...input, status: 'queued' }); } });
  ({ store } = fx);
  const dm = userDm(fx.social);
  const trigger = fx.social.postMessage(dm.id, { content: '请记录知识并派发测试工作' });
  await idle(fx.social);
  assert.equal(store.list('memories')[0].source, `message:${trigger.id}`);
  assert.equal(store.list('nodes')[0].type, 'hypothesis');
  assert.equal(store.list('works')[0].sourceMessageId, trigger.id);
  assert.deepEqual(store.list('works')[0].inputRefs, ['test-ref']);
  const job = store.list('jobs')[0];
  store.save('jobs', { ...job, status: 'interrupted', appliedActions: [] });
  await fx.social.handle('POST', `/api/jobs/${encodeURIComponent(job.id)}/retry`, {});
  await idle(fx.social);
  assert.equal(workCreates, 1);
  assert.equal(store.list('memories').length, 1);
  assert.equal(store.list('memories')[0].history.length, 0);
  assert.equal(store.list('nodes').length, 1);
  assert.equal(store.list('nodes')[0].history.length, 0);
});

test('deep conclusions state failed rounds and concluded rooms reject stale retries', async t => {
  const { social, store, calls } = fixture(t, async input => {
    if (input.messages[0].content.includes('平级讨论的记录者')) return response({ title: '有限结论', content: '仅有组件建议，工程意见缺失。' });
    const data = JSON.parse(input.messages[1].content);
    if (data.bot.id === 'bot-engineer') throw new Error('测试某轮网络失败');
    return response({ reply: '仅供讨论的组件建议', actions: [] });
  });
  const deep = social.createRoom({ kind: 'deep', name: '有失败的讨论', goal: '讨论验证限制', members: ['bot-engineer', 'bot-components'], rounds: 1 });
  await idle(social);
  const ended = store.get('rooms', deep.id);
  assert.equal(ended.status, 'concluded');
  assert.match(ended.conclusion, /工程伙伴 第 1 轮 failed/);
  assert.match(ended.conclusion, /实际取得的发言/);
  const conclusionCall = calls.find(input => input.messages[0].content.includes('平级讨论的记录者'));
  assert.equal(JSON.parse(conclusionCall.messages[1].content).failures.length, 1);
  const failed = store.list('jobs').find(job => job.status === 'failed');
  await assert.rejects(social.handle('POST', `/api/jobs/${encodeURIComponent(failed.id)}/retry`, {}), error => error.status === 409);
  assert.equal(store.get('jobs', failed.id).status, 'failed');
});

test('context summaries preserve original messages and do not mix private rooms or other Bot memories', async t => {
  const { social, store, calls } = fixture(t, async input => input.json
    ? response({ reply: '摘要已使用', actions: [] }) : response('摘要：保留长期约束与未决事项。'));
  const dm = userDm(social);
  const other = social.createRoom({ kind: 'dm', members: ['user', 'bot-qa'], name: '另一私聊' });
  social.appendMessage(other.id, { content: 'OTHER_ROOM_PRIVATE' }, 'user');
  social.saveMemory('bot-qa', { content: 'OTHER_BOT_PRIVATE', category: 'private' });
  social.saveMemory('bot-engineer', { content: 'OWN_MEMORY', category: 'professional' });
  for (let i = 0; i < 32; i++) social.appendMessage(dm.id, { content: `历史消息 ${i}` }, 'user');
  social.postMessage(dm.id, { content: '继续讨论' });
  await idle(social);
  assert.equal(social.roomMessages(dm.id).length, 34);
  assert.match(store.get('rooms', dm.id).summary, /长期约束/);
  const actualContext = calls.find(input => input.json).messages[1].content;
  assert.match(actualContext, /OWN_MEMORY/);
  assert.doesNotMatch(actualContext, /OTHER_ROOM_PRIVATE|OTHER_BOT_PRIVATE|历史消息 0"/);
  assert.match(actualContext, /摘要：保留长期约束/);
});

test('knowledge relations, revision history, expiration, and owner-specific memory are durable', async t => {
  const { social, store } = fixture(t);
  const requirement = social.saveNode({ title: '需求', content: '列表', type: 'fact', source: '用户原文', version: 'v1' });
  const component = social.saveNode({ title: '组件', content: '复用组件', source: '代码检查待办' });
  social.saveEdge({ from: requirement.id, to: component.id, relation: 'uses', source: '显式输入' });
  const revised = social.saveNode({ id: component.id, content: '需要验证版本', status: 'disputed', version: 'v2' });
  assert.equal(revised.history[0].content, '复用组件');
  assert.equal(revised.source, '代码检查待办');
  assert.equal(social.graph(requirement.id, 1).nodes.length, 2);
  const expired = social.saveMemory('bot-engineer', { content: '旧经验', expiresAt: new Date(Date.now() - 100).toISOString() });
  social.expireRecords();
  assert.equal(store.get('memories', expired.id).status, 'expired');
  assert.equal(store.get('memories', expired.id).history.length, 1);
  assert.throws(() => social.saveMemory('bot-qa', { id: expired.id, content: '覆盖别人的记忆' }), /其他成员/);
});

test('persisted routines catch up once and events wake only their addressed Bot', async t => {
  const { social, store, calls } = fixture(t, async () => response({ pass: true, reply: '', actions: [] }));
  const routine = social.saveRoutine({ name: '职责', botId: 'bot-qa', roomId: 'room-lobby', instruction: '检查本轮来源', intervalSeconds: 3600,
    nextRunAt: new Date(Date.now() - 86400000).toISOString() });
  social.tick(); social.tick();
  await idle(social);
  assert.equal(store.list('messages').filter(message => message.routineId === routine.id).length, 1);
  assert.ok(new Date(store.get('routines', routine.id).nextRunAt).getTime() > Date.now());
  assert.equal(store.get('routines', routine.id).lastStatus, 'completed');
  const result = await social.handle('POST', '/api/events', { type: 'file-change', content: '文件变更测试事件', roomId: 'room-lobby', botId: 'bot-components' });
  await idle(social);
  assert.equal(result.jobs.length, 1);
  assert.equal(store.get('jobs', result.jobs[0].id).botId, 'bot-components');
  assert.equal(calls.length, 2);
});

test('restart resumes queued jobs but marks previously running jobs interrupted', async () => {
  const store = new Store(':memory:');
  const provider = { complete: async () => response({ pass: true, actions: [] }) };
  const previous = new SocialRuntime({ store, provider });
  const room = userDm(previous);
  previous.postMessage(room.id, { content: '队列待恢复' });
  store.save('jobs', { id: 'interrupted-job', type: 'turn', lane: 'fast', roomId: room.id, botId: 'bot-engineer', status: 'running', attempts: 1 });
  const restored = new SocialRuntime({ store, provider });
  try {
    restored.start();
    await idle(restored);
    assert.equal(store.get('jobs', 'interrupted-job').status, 'interrupted');
    assert.equal(store.list('jobs').filter(job => job.status === 'completed').length, 1);
  } finally { await restored.stop(); store.close(); }
});

test('consultations use an attributed DM, and work terminal reports are idempotent', async t => {
  const { social, store, calls } = fixture(t, async () => response('测试专家答复：保存来源和适用版本。'));
  const work = { id: 'work-test', goal: '验证咨询', botId: 'bot-engineer', roomId: 'room-lobby', status: 'running' };
  const answer = await social.consult(work, { question: '如何记录来源？', targetBotId: 'bot-components' });
  assert.match(answer, /保存来源/);
  const dm = store.list('rooms').find(room => room.members.includes('executor:work-test'));
  const messages = social.roomMessages(dm.id);
  assert.equal(messages[0].senderId, 'executor:work-test');
  assert.equal(messages[1].senderId, 'bot-components');
  assert.equal(messages[1].workId, work.id);
  assert.equal(calls[0].json, false);
  const finished = { ...work, status: 'completed', summary: '真实结果应由执行器给出', finishedAt: '2026-10-18T10:00:00Z' };
  social.workUpdate(finished); social.workUpdate(finished);
  assert.equal(social.roomMessages('room-lobby').filter(message => message.workId === work.id).length, 1);
  assert.equal(store.list('jobs').length, 0, 'report must not recursively re-run work');
});

test('model failures remain errors and graceful stop prevents late SQLite writes', async () => {
  const store = new Store(':memory:');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const social = new SocialRuntime({ store, provider: { complete: async () => { await gate; return response({ reply: '迟到回复', actions: [] }); } } });
  social.start();
  const room = userDm(social);
  social.postMessage(room.id, { content: '停止过程测试' });
  await until(() => social.running.size === 1);
  const closing = social.stop();
  release();
  await closing;
  assert.equal(store.list('jobs')[0].status, 'interrupted');
  assert.ok(!social.roomMessages(room.id).some(message => message.content === '迟到回复'));
  social.provider.complete = async () => { throw new Error('测试网络错误'); };
  social.start();
  social.postMessage(room.id, { content: '失败测试' });
  await idle(social);
  const failed = store.list('jobs').find(job => job.status === 'failed');
  assert.match(failed.error, /网络错误/);
  assert.equal(social.roomMessages(room.id).filter(message => message.kind === 'error').length, 1);
  assert.equal(socialReplies(social, room.id).length, 0);
  await social.stop();
  store.close();
});
