import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// The default run observes EggBot's actual decisions. --settled-week replays a fully delivered
// handoff. --capabilities drives just the platform operations without contacting a model.
const { dataRoot, releaseRoot, buildId } = JSON.parse(readFileSync('D:/Relay-Bot-app/current.json', 'utf8'));
const installed = path => import(pathToFileURL(join(releaseRoot, path)).href);
const [
  { RecordStore }, { SummonPlatform }, { ChatroomService }, { AttachmentStore }, { ModelConnections },
  { SummonConnections, connectionRecords }, { BotRuntime }, { BotEngine }, { MaterialRuntime },
  { BotStore }, { Inbox }, { runtimeRecords: R }, { tools, user }, { deliveryRecords, wakeupRecords },
  { AssistantMessageEventStream },
] = await Promise.all([
  'capabilities/shared/store.mjs', 'capabilities/platform/platform.mjs', 'capabilities/chatroom/service.mjs',
  'capabilities/chatroom/attachments.mjs', 'capabilities/models/service.mjs', 'capabilities/services/connections.mjs',
  'bot/src/runtime/bot.mjs', 'bot/src/agent/engine.mjs', 'bot/src/context/materials.mjs',
  'bot/src/storage/store.mjs', 'bot/src/storage/inbox.mjs', 'bot/src/storage/runtime-records.mjs',
  'capabilities/platform/contract.mjs', 'capabilities/platform/delivery.mjs',
  'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js',
].map(installed));

const caseId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const root = join('D:/summontest/eggbot-two-rooms', caseId);
const snow = join(root, 'snow'), coast = join(root, 'coast'), records = join(coast, '.case');
for (const path of [snow, records]) mkdirSync(path, { recursive: true });
const trace = join(records, 'run.jsonl');
const log = (event, fields = {}) => {
  const line = JSON.stringify({ stage, event, ...fields });
  appendFileSync(trace, line + '\n');
  console.log(line);
};
let stage = 'setup';
const scenarioOnly = process.argv.includes('--capabilities');
const closedWeekOnly = process.argv.includes('--settled-week');
let realClosure = false;
const live = new DatabaseSync(join(dataRoot, 'capabilities/chatroom/state.sqlite'), { readOnly: true });
const liveRecord = (kind, id) => JSON.parse(live.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id).data);
const egg = 'bot-eggbot', eggConfig = liveRecord('platform-bots', egg);
const oldTool = liveRecord(connectionRecords, 'cli-b08c2007-14d8-4ba7-bf87-6f611f3257b8');
const nameOf = id => names.get(id) ?? id;
const names = new Map([[egg, 'EggBot'], [user.id, '用户']]);
const ref = (kind, id) => ({ kind, id });
const botRef = id => ref('bot', id);
const eventRef = id => ref('event', id);
const workRef = workspace => ref('workspace', workspace.id);
const host = { actor: user };
const models = new ModelConnections({ dataRoot });
const model = { connectionStore: models.path };
// Native workers open this same SQLite file to recheck the actual caller, room and connection.
const store = new RecordStore(join(records, 'scenario.sqlite'));
const attachments = new AttachmentStore(records);
const platform = new SummonPlatform({ store, dataRoot, releaseRoot, models, attachments,
  limits: liveRecord('platform-host-limits', 'host').limits });
const directory = platform.manager.directory.bind(platform.manager);
platform.manager.directory = id => { directory(id); return records; };
const room = new ChatroomService({ store, manager: platform.manager, platform, attachments,
  emit(type, entry) {
    if (type === 'message') log('message', { room: entry.roomId, id: entry.id, by: nameOf(entry.senderId),
      text: entry.content, reply: entry.replyTo, mentions: entry.mentions, files: entry.attachments.map(f => f.id) });
  } });
const connections = new SummonConnections({ store, dataRoot, workspace: coast,
  assertSessionAuthority: (session, options) => platform.assertSessionAuthority(session, options),
  onWorkEvent: (...args) => platform.roomWork.publish(...args),
  onEvent: (id, call, facts) => platform.recordReceipt(call, facts, id) });
connections.processes.directory = op => join(records, 'executions', op.instance_id);
const expectedTips = new Map();
const runtime = new BotRuntime({ dataRoot, releaseRoot, model, platform, emit(type, value) {
  if (['engine.runtime_error', 'engine.interrupted'].includes(type)) log(type, value);
  if (type === 'engine.request') {
    const c = store.get('platform-conversations', value.conversation_id);
    if (c?.space?.kind === 'room') expectedTips.set(value.run_id, room.messages(c.space.id, user).at(-1)?.id);
  }
} });
runtime.inbox = async id => {
  if (!runtime.inboxes.has(id)) runtime.inboxes.set(id, new Inbox(new BotStore(':memory:'), id));
  return runtime.inboxes.get(id);
};
runtime.wake = () => {}; // Advance real intake and the run scheduler at the scene's delivery boundaries.
runtime.materials = new MaterialRuntime(runtime);
runtime.engine = new BotEngine({ model, platform, toolSpecs: tools, emit: runtime.emit, clean: runtime.clean });
platform.attach({ room, connections, runtime });
const usage = live.prepare("SELECT rowid AS n, json_extract(data,'$.resource') AS resource, json_extract(data,'$.began_at') AS began_at, json_extract(data,'$.ended_at') AS ended_at, json_extract(data,'$.tokens') AS tokens, json_extract(data,'$.reserved_tokens') AS reserved_tokens FROM records WHERE kind='platform-usage' AND (json_extract(data,'$.ended_at') IS NULL OR json_extract(data,'$.ended_at')>=?)");
const acquire = platform.acquireModel.bind(platform);
platform.acquireModel = (...args) => {
  if (args[0].actor.id === egg) for (const { n, ...row } of usage.all(platform.resources.bounds().from))
    store.save('platform-usage', { id: 'host-capacity-' + n, ...row });
  return acquire(...args);
};
const hostTool = (name, args) => platform.invoke(name, args, { ...host, clientId: randomUUID() });

const captured = [], calls = [], results = [], programs = [], byRun = new Map(), contexts = new Map();
const originalStream = runtime.engine.provider.stream.bind(runtime.engine.provider);
const invoke = platform.invoke.bind(platform);
const printArgs = (tool, args) => tool === 'configure_bot' || tool === 'create_bot' ?
  { name: args.name, bot: args.bot, public_duty: args.public_duty } : args;
platform.invoke = async (tool, args, context) => {
  if (context.actor.kind === 'user') return invoke(tool, args, context);
  const actor = context.actor.id, origin = context.origin;
  const entry = { actor, stage, tool, args: printArgs(tool, args), conversation: origin.conversation_id, call: context.call_id };
  calls.push(entry);
  try {
    const result = await invoke(tool, args, context);
    entry.id = result?.id || result?.message?.id;
    if (tool === 'find') entry.hits = result.items?.map(item => item.id);
    log('tool', { ...entry, status: result?.status, hitIds: entry.hits, revision: result?.revision,
      ...(tool === 'read' && args.path ? { text: result.content } : {}) });
    return result;
  } catch (error) {
    entry.error = error.code || error.message;
    log('tool_error', { ...entry, detail: error.message });
    throw error;
  }
};
function inspectRequest(context, job) {
  const facts = [];
  for (const message of context.messages) {
    if (message.role !== 'user') continue;
    for (const part of message.content || []) {
      if (part.type === 'text') { try { facts.push(JSON.parse(part.text)); } catch {} }
    }
  }
  const summary = facts.find(value => value.type === 'derived_history');
  const roomId = job.conversation.space.kind === 'room' ? job.conversation.space.id : null;
  const events = facts.filter(value => ['current_event', 'historical_entry'].includes(value.type) &&
    value.event.type === 'message' && value.event.space?.id === roomId);
  const frame = { stage, bot: job.inbox.botId, conversation: job.conversation.id, run: job.runId, room: roomId,
    session: job.conversation.session_id, summary, events, facts, through: job.inbox.run(job.runId).history_read_through, tip: expectedTips.get(job.runId),
    system: context.messages.find(m => m.role === 'system')?.content };
  captured.push(frame);
  if (roomId) contexts.set(job.inbox.botId + '/' + roomId, job.context());
  if (frame.session) contexts.set(frame.session, job.context());
  return frame;
}
function script(label, actor, matches, generate) {
  const program = { label, actor, matches, generate, started: false, done: false };
  programs.push(program);
  return program;
}
const action = (name, args) => ({ name, args });
const say = (to, text, extra = {}) => action('send', { message: { to, text, ...extra } });
function scriptedTurn(frame, context) {
  const run = frame.run;
  let turn = byRun.get(run);
  if (!turn || turn.program.done) {
    const program = programs.find(p => !p.started && p.actor === frame.bot && p.matches(frame));
    if (!program) return;
    program.started = true;
    turn = { program, iterator: program.generate(frame) };
    byRun.set(run, turn);
  }
  if (turn.program.done) return;
  try {
    const previous = turn.toolId && context.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === turn.toolId);
    if (turn.toolId && !previous) throw Error('The model input did not contain its preceding tool result');
    const result = previous && JSON.parse(previous.content[0].text);
    if (previous?.isError) throw Error(result.code + ': ' + result.message);
    const next = turn.iterator.next(result);
    if (next.done) { turn.program.done = true; turn.program.result = next.value; return; }
    turn.toolId = randomUUID();
    return { type: 'toolCall', id: turn.toolId, name: next.value.name, arguments: next.value.args };
  } catch (error) {
    turn.program.done = true;
    turn.program.error = error.message;
    log('script_error', { label: turn.program.label, error: error.message });
  }
}
let realRequests = 0, inspectDirectory;
runtime.engine.provider.stream = (selected, context, options) => {
  const { botId, runId, purpose } = options.usageContext;
  const job = [...runtime.active.values()].find(value => value.runId === runId);
  assert(job);
  const before = async () => {
    await options.beforeFetch();
    const frame = inspectRequest(context, job);
    if (botId === egg && inspectDirectory) {
      const probe = inspectDirectory; inspectDirectory = null;
      await test('入群前的三种名册查询（定向）', () => probe(job.context()));
    }
    return frame;
  };
  if (botId === egg && !scenarioOnly && (!closedWeekOnly || realClosure)) {
    assert.equal(selected.id, eggConfig.model.id);
    return originalStream(selected, context, { ...options, beforeFetch: async () => {
      await before();
      realRequests++;
      log('external_model', { actor: botId, model: selected.id, purpose, run: runId, request: realRequests });
    } });
  }
  const stream = new AssistantMessageEventStream();
  (async () => {
    const frame = await before();
    assert.notEqual(purpose, 'compression', 'A shared-summary replay needs the stored summary and original suffix');
    const call = scriptedTurn(frame, context);
    const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
      timestamp: Date.now(), content: [call || { type: 'text', text: '本次收件已处理。' }],
      stopReason: call ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, generationBudget: { input: 0, output: 0 } };
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end();
  })().catch(error => {
    const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: error.message, timestamp: Date.now() };
    stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
  });
  return stream;
};

async function settle() {
  const end = performance.now() + 240000;
  for (;;) {
    await connections.tick();
    await platform.tick();
    await runtime.pump();
    await Promise.all([...runtime.starting.values()]);
    const boxes = [...runtime.inboxes.values()];
    const native = store.list('session-operations').some(o => !['completed', 'failed', 'not_submitted', 'stopped', 'unknown', 'unsupported'].includes(o.status));
    const deliveries = store.list(deliveryRecords).some(d => ['pending', 'unknown'].includes(d.status));
    const pending = boxes.flatMap(i => i.pending().filter(q => !['suspended','interrupted','access_revoked'].includes(i.run(q.run_id)?.state)));
    const retries = boxes.flatMap(i => i.store.listRecords(R.run).filter(r => r.state === 'retry'));
    if (!native && !deliveries && !pending.length && !runtime.active.size && !retries.length) break;
    if (performance.now() > end) throw Error('Scheduler still pending: ' + JSON.stringify({ native, deliveries, pending: pending.length, retries: retries.map(r => r.error) }));
    await delay(retries.length ? 500 : 40);
  }
}
async function test(label, fn) {
  try { const value = await fn(); results.push({ label, ok: true, value }); log('pass', { label, value }); return value; }
  catch (error) { results.push({ label, ok: false, error: error.message }); log('fail', { label, error: error.message }); }
}
function finished(p) { assert(p.started && p.done, p.label + ' did not run'); assert(!p.error, p.label + ': ' + p.error); return p.result; }
const send = (where, text, by = user, extra = {}) => room.send(where.id, { text, ...extra }, by).message;
const incoming = (where, id) => frame => frame.room === where.id && frame.events.some(e => e.type === 'current_event' && e.event.id === id);
const onPi = (actor, workspace, task) => frame => frame.bot === actor && frame.session &&
  frame.facts.some(f => f.type === 'session_resources' && f.workspace?.id === workspace.id) &&
  frame.facts.some(f => f.type === 'current_event' && f.event.type === 'pi.input' && JSON.stringify(f.event).includes(task));
const readTable = workspace => action('read', { ref: workRef(workspace), path: '章表.csv' });
function* writeTable(workspace, change) {
  const before = yield readTable(workspace);
  const text = change(before.content);
  yield action('save_file', { space: workRef(workspace), path: '章表.csv', revision: before.revision, content_or_source: { text } });
  const after = yield readTable(workspace);
  assert.equal(after.content, text);
  return text;
}
function* resume(id, input) {
  const target = ref('session', id);
  const latest = yield action('read', { ref: target });
  const next = latest.input_targets.find(t => t.kinds.includes('next'));
  assert(next, 'No next input target for ' + id + ': ' + JSON.stringify({ status: latest.status, targets: latest.input_targets }));
  return yield action('send_input', { target, input, kind: 'next', input_target: next.input_target, control_version: latest.control_version });
}
function checkPublic(frame, where, otherText, summary) {
  assert(frame, 'No first provider input');
  const original = room.messages(where.id, user);
  assert.equal(frame.through, frame.tip, 'Final input must reach the public Room tip at assembly');
  const through = original.findIndex(m => m.id === frame.through);
  assert(through >= 0);
  const start = summary ? original.findIndex(m => m.id === summary.through) + 1 : 0;
  const expected = original.slice(start, through + 1);
  assert.equal(frame.summary?.covered_through, summary?.through);
  assert.equal(frame.summary?.text, summary?.summary);
  assert.deepEqual(frame.events.map(v => v.event.id), expected.map(m => m.id));
  for (const [index, m] of expected.entries()) {
    const { event, ref: actualRef } = frame.events[index];
    assert.equal(actualRef.id, m.id); assert.equal(event.text, m.content); assert.equal(event.author.id, m.senderId);
    assert.equal(event.space.id, where.id); assert.equal(event.sequence, m.sequence);
    assert.equal(event.reply_to ?? null, m.replyTo ?? null);
    assert.deepEqual(event.mentions, m.mentions); assert.deepEqual(event.references, m.references);
    assert.deepEqual(event.attachments.map(f => f.id), m.attachments.map(f => f.id));
  }
  assert(!JSON.stringify(frame.facts).includes(otherText));
  return { conversation: frame.conversation, through: frame.through, count: expected.length, summary: frame.summary,
    originals: expected.map(m => ({ id: m.id, reply: m.replyTo, attachments: m.attachments.map(f => f.id) })) };
}

const header = '章节,路线,奖励\n';
const snowText = header + '雪原章,冰道,6\n';
const safeLine = '海岸章,稳妥线,2\n';
const riskLine = n => '海岸章,冒险线,' + n + '\n';
const snowOnly = '雪原独用口令：冰桥在第三座灯塔转弯';
const plannerPrivate = '个人工作约定：落笔前回读章表。';
let A, B, wa, wb, lead, planner, spare, offDuty, attachment, oldRule, corrected, videoMessage;
let toolsNew, runner, piB, piA, cliB, cliA, nestedCli, ownerDelivery;

// The fixture footage is a replay of a token taking the branching coast route and reaching its reward.
function clip() {
  const width = 160, height = 90, count = 24;
  const pixels = Buffer.alloc(width * height * 3 * count);
  for (let frame = 0; frame < count; frame++) {
    const px = 12 + Math.round(frame * 5.4), py = 65 - Math.round(frame * 1.6);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const path = Math.abs(y - (68 - x * 0.30)) < 3 || Math.abs(y - (64 + x * 0.08)) < 3;
      const reward = x >= 130 && x <= 141 && y >= 24 && y <= 35;
      const token = (x - px) ** 2 + (y - py) ** 2 < 25;
      const color = token ? [245, 240, 205] : reward ? [245, 185, 34] : path ? [145, 178, 149] :
        (y < 13 ? [11, 40, 55] : [24, 83 + Math.floor(y / 3), 120]);
      const i = ((frame * height + y) * width + x) * 3;
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2];
    }
  }
  const result = spawnSync(oldTool.config.file, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', width + 'x' + height, '-framerate', '12', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'], { input: pixels, windowsHide: true });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
}

// Registered through the host's normal connection settings. The adapter needs the separate Node runner at launch.
async function sampleAdapter() {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const { createInterface } = await import('node:readline');
  const emit = (type, value) => console.log(JSON.stringify({ summonEvent: { type, ...value } }));
  const lines = createInterface({ input: process.stdin });
  const { value } = await lines[Symbol.asyncIterator]().next();
  const { executable, text, sessionId } = JSON.parse(value).summonStart;
  lines.close();
  emit('session', { sessionId: sessionId || randomUUID() });
  let out;
  if (text === '读章表') out = readFileSync('章表.csv', 'utf8');
  else {
    if (!['主控', '策划'].includes(text)) throw Error('Unknown sample action');
    const result = spawnSync(executable, ['-v', 'error', '-i', text + '-录像.mp4', '-ss', '1',
      '-frames:v', '1', '新工具-' + text + '.png'], { windowsHide: true });
    if (result.status !== 0) throw Error(result.stderr.toString());
    out = '新工具-' + text + '.png';
  }
  emit('result', { text: out, confirmed: true }); emit('outcome', { status: 'completed' });
}
async function setup() {
  assert.equal(eggConfig.built_in_role.id, 'eggbot');
  assert.equal(oldTool.enabled, true);
  writeFileSync(join(snow, '章表.csv'), snowText, { flag: 'wx' });
  writeFileSync(join(coast, '章表.csv'), header, { flag: 'wx' });
  wa = platform.configureWorkspace({ name: '雪原项目', path: snow, write: true });
  wb = platform.configureWorkspace({ name: '海岸项目', path: coast, write: true });
  platform.manager.saveNew({ id: egg, name: eggConfig.name, instructions: eggConfig.instructions,
    model: eggConfig.model, built_in_role: eggConfig.built_in_role, owner: user });
  store.save('platform-access', { ...liveRecord('platform-access', egg), workspace_ids: [] });
  async function member(name, public_duty, instructions) {
    const bot = await hostTool('create_bot', { name, public_duty, instructions, model: eggConfig.model });
    names.set(bot.id, name);
    return bot.id;
  }
  lead = await member('海岸主控', '路线程序、存档和结算集成', '只负责程序和存档，关卡平衡由关卡负责人决定。');
  planner = await member('岑舟', '关卡策划，关卡经济、奖励平衡、章表和持续试玩反馈', plannerPrivate);
  spare = await member('铃音', '场景美术和素材归档', '维护场景色稿。');
  offDuty = await member('停班校对', '文本校对', '校对地名。');
  await hostTool('configure_bot', { bot: offDuty, revision: platform.getBot(offDuty).revision, enabled: false });
  A = (await hostTool('create_room', { title: '甲群 · 雪原远征', members: [planner], mode: 'group', workspace: wa.id })).ref;
  B = (await hostTool('create_room', { title: '乙群 · 雾港远征海岸章', members: [lead, egg], mode: 'group' })).ref;
  await hostTool('configure_room', { room: B, revision: room.room(B.id, user).revision, workspace: workRef(wb) });
  assert(!room.room(A.id, user).members.includes(egg));
  assert.deepEqual(store.get('platform-access', planner).workspace_ids, []);
  assert.deepEqual(store.get('platform-access', lead).workspace_ids, []);
  store.import(connectionRecords, oldTool);
  runner = await platform.configureExecutionConnection({ kind: 'cli', name: '样例 Node 解释器',
    config: { file: process.execPath, canonical_file: realpathSync(process.execPath) } }, host);
  toolsNew = await platform.configureExecutionConnection({ kind: 'cli', name: '海岸看片与章表',
    description: '用文本“主控”或“策划”从该成员的录像抽一帧；“读章表”回读本群表格。',
    dependencies: [runner.id], config: { file: oldTool.config.file, canonical_file: oldTool.config.canonical_file,
      adapter: { source: 'await (' + sampleAdapter.toString() + ')();',
        runner: { id: runner.id, binding_version: runner.binding_version }, resume: true } } }, host);
  assert.notEqual(toolsNew.id, oldTool.id);
  const raw = clip();
  attachment = await attachments.upload({ name: '海岸试玩录像.mp4', data: raw.toString('base64'), mimeType: 'video/mp4' }, { ownerId: user.id });
  log('setup', { buildId, caseId, root, A, B, actors: Object.fromEntries(names), old: oldTool.id, new: toolsNew.id,
    dependency: runner.id, personalWorkspaces: [], mode: closedWeekOnly ? 'settled-week' : scenarioOnly ? 'capabilities' : 'actual-eggbot', trace });
}
async function kickoff() {
  stage = '① 自主选人';
  send(A, snowOnly + '。雪原章表和海岸章分别维护。');
  oldRule = send(B, '海岸章首版选两条路线，稳妥线给 2 枚勋章，冒险线也先给 2 枚。');
  corrected = send(B, '更正冒险线奖励为 3，稳妥线仍为 2。请以此回复为准。', user, { reply_to: eventRef(oldRule.id) });
  videoMessage = send(B, '这是海岸路线的试玩录像，第 1 秒有分岔。', user, { attachments: [attachment.ref] });
  send(B, '我认领程序和存档对接，负责读表结算。这次没有人接章表和平衡反馈。', lead);
  send(B, '海岸章两条路线都要交奖励表，接下来几章的试玩反馈也找交首版的人。');
  inspectDirectory = async context => {
    const lookup = args => invoke('find', { kind: 'bot', ...args }, context);
    const byDuty = (await lookup({ query: '奖励平衡' })).items, notJoined = (await lookup({ query: '场景美术' })).items;
    const scoped = (await lookup({ scope: B })).items;
    const inactive = (await lookup({ query: '停班校对' })).items;
    assert.deepEqual(byDuty.map(v => v.id), [planner]); assert.equal(byDuty[0].name, '岑舟');
    assert.equal(byDuty[0].enabled, true); assert(byDuty[0].public_duty.includes('关卡经济'));
    assert(!Object.hasOwn(byDuty[0], 'instructions') && !Object.hasOwn(byDuty[0], 'model'));
    assert.deepEqual(notJoined.map(v => v.id), [spare]); assert(!room.rooms(spare).length);
    assert.deepEqual(scoped.map(v => v.id).sort(), [egg, lead].sort());
    assert.equal(inactive[0].id, offDuty); assert.equal(inactive[0].enabled, false);
    return { byDuty, notJoined: notJoined.map(v => v.id), scoped: scoped.map(v => v.id), inactive };
  };
  await settle();
  const chosen = room.room(B.id, user).members.includes(planner);
  log('blind_choice', { real: !scenarioOnly, chosen, planner, decision: calls.filter(c => c.stage === stage && c.actor === egg)
    .map(({ tool, args, hits, error }) => ({ tool, args, hits, error })), members: room.room(B.id, user).members });
  stage = '② 入群交接';
  if (!chosen) {
    await test('原 ID 的定向邀请', async () => {
      const context = contexts.get(egg + '/' + B.id);
      assert(context, 'No EggBot context');
      const selection = (await invoke('find', { kind: 'bot', query: '关卡经济' }, context)).items.find(b => b.id === planner);
      const invited = await invoke('configure_room', { room: B, revision: room.room(B.id, user).revision, add_members: [selection.id] },
        { ...context, call_id: randomUUID() });
      assert(invited.members.includes(planner)); return selection.id;
    });
  }
  const handoff = send(B, '按刚才定好的规则出表。', user, { mentions: [planner] });
  const claim = script('策划认领两线', planner, incoming(B, handoff.id), function* () {
    return yield say(B, '我接两条路线的海岸章表，并接后续试玩反馈。稳妥线和冒险线会一起交。', { reply_to: eventRef(handoff.id) });
  });
  await settle();
  await test('首次公共输入与另一群隔离', () => {
    const first = captured.find(f => f.bot === planner && f.room === B.id);
    const value = checkPublic(first, B, snowOnly);
    const ids = first.events.map(v => v.event.id);
    for (const m of [oldRule, corrected, videoMessage]) assert(ids.includes(m.id));
    assert(String(first.system).includes(plannerPrivate));
    const a = captured.find(f => f.bot === planner && f.room === A.id);
    assert.notEqual(a.conversation, first.conversation);
    assert(!JSON.stringify(a.facts).includes(oldRule.content));
    finished(claim); return value;
  });
}
function verifyFrame(filename) {
  const path = join(coast, filename);
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const image = spawnSync(oldTool.config.file, ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
  assert.equal(image.status, 0, image.stderr?.toString()); assert.equal(image.stdout.length, 160 * 90 * 3);
  const marker = (46 * 160 + 77) * 3;
  assert(image.stdout[marker] > 185 && image.stdout[marker + 1] > 185, 'Replay token missing at 1 second');
  return { filename, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}
async function mediaAndSessions() {
  stage = '③ 工具、目录与首版';
  const request = send(B, '主控和策划各自从刚才那段试玩录像的第 1 秒抽帧，各自核对画面；策划先把稳妥线写进项目里的章表。');
  const piTask = '回读海岸章并先写稳妥线';
  const firstPi = script('乙群 Pi 写稳妥线', planner, onPi(planner, wb, piTask), function* () {
    const actual = yield* writeTable(wb, content => { assert.equal(content, header); return content + safeLine; });
    const found = yield action('find', { kind: 'connection', query: toolsNew.name });
    assert(found.items.some(c => c.id === toolsNew.id));
    const use = yield action('read', { ref: ref('connection', toolsNew.id) });
    assert(use.available);
    nestedCli = (yield action('open_session', { engine: toolsNew.id, input: '读章表' })).id;
    return actual;
  });
  const jobs = [];
  for (const [id, short] of [[lead, '主控'], [planner, '策划']]) {
    jobs.push(script('两种工具-' + short, id, incoming(B, request.id), function* () {
      const available = yield action('find', { kind: 'workspace' });
      assert.deepEqual(available.items.map(v => v.id), [wb.id]);
      if (id === planner) piB = (yield action('open_session', { engine: 'pi', input: piTask })).id;
      const paths = [];
      for (const item of [oldTool, toolsNew, runner]) {
        const found = yield action('find', { kind: 'connection', query: item.name });
        assert(found.items.some(hit => hit.id === item.id));
        const doc = yield action('read', { ref: ref('connection', item.id) });
        assert(doc.available && doc.input);
        paths.push(item.id);
      }
      const source = short + '-录像.mp4', output = '旧工具-' + short + '.png';
      yield action('save_file', { space: workRef(wb), path: source, content_or_source: { source: attachment.ref } });
      const args = ['-v', 'error', '-i', source, '-ss', '1', '-frames:v', '1', output];
      const old = yield action('open_session', { engine: oldTool.id, input: { args,
        file_args: [{ index: 3, access: 'read' }, { index: 8, access: 'write' }] } });
      const fresh = yield action('open_session', { engine: toolsNew.id, input: short });
      if (id === planner) cliB = fresh.id;
      return { caller: id, paths, old: old.id, fresh: fresh.id, short };
    }));
  }
  const aJob = '回读雪原并核对冰道';
  const aMessage = send(A, '请从雪原群打开工作会话，核对本群章表里的冰道，并登记冰湖路线。');
  const pa = script('甲群 Pi 读写', planner, onPi(planner, wa, aJob), function* () {
    return yield* writeTable(wa, content => { assert.equal(content, snowText); return content + '雪原章,冰湖,8\n'; });
  });
  const aOpen = script('甲群两种工作会话', planner, incoming(A, aMessage.id), function* () {
    const dir = yield action('find', { kind: 'workspace' });
    assert.deepEqual(dir.items.map(d => d.id), [wa.id]);
    piA = (yield action('open_session', { engine: 'pi', input: aJob })).id;
    cliA = (yield action('open_session', { engine: toolsNew.id, input: '读章表' })).id;
    return { piA, cliA };
  });
  await settle();
  for (const job of jobs) await test(job.label, () => {
    const value = finished(job);
    const opened = [value.old, value.fresh].map(id => {
      const s = store.get('platform-sessions', id), op = connections.operations(s).at(-1);
      assert.equal(op?.status, 'completed', op?.error); assert.equal(op.execution_actor.id, value.caller);
      assert.equal(op.cwd, coast); assert.equal(s.project_room.id, B.id);
      return { session: id, cwd: op.cwd, actor: op.execution_actor.id, connection: op.connection_id, status: op.status };
    });
    return { opened, dependency: runner.id, frames: ['旧工具-', '新工具-'].map(prefix => verifyFrame(prefix + value.short + '.png')) };
  });
  await test('甲乙 Pi 选目录及同名文件读写', () => {
    finished(firstPi); finished(pa); finished(aOpen);
    for (const [session, where, path] of [[piA,A,snow],[piB,B,coast],[cliA,A,snow],[cliB,B,coast],[nestedCli,B,coast]]) {
      const value = store.get('platform-sessions', session);
      assert.equal(value.project_room.id, where.id); assert.equal(value.workspace.path, path);
    }
    assert.equal(readFileSync(join(coast, '章表.csv'), 'utf8'), header + safeLine);
    assert.equal(readFileSync(join(snow, '章表.csv'), 'utf8'), snowText + '雪原章,冰湖,8\n');
    const nested = connections.operations({ id: nestedCli }).at(-1);
    assert.equal(nested.status, 'completed', nested.error); assert.equal(nested.result.text.trimEnd(), (header + safeLine).trimEnd());
    return { piA, piB, cliA, cliB, nestedCli, snow: finished(pa), coast: finished(firstPi) };
  });
  const fromA = send(A, '请沿刚才的工作会话再读一次雪原章表。');
  const fromB = send(B, '请沿刚才的看片工具会话再读一次海岸章表。');
  const follow = [[A, fromA, cliA], [B, fromB, cliB]].map(([r, m, id]) =>
    script('接续外部-' + r.id, planner, incoming(r, m.id), function* () { return yield* resume(id, '读章表'); }));
  await settle();
  for (const [index, p] of follow.entries()) await test('外部会话接续' + ['甲','乙'][index], () => {
    finished(p);
    const id = [cliA, cliB][index], dir = [snow, coast][index];
    const list = connections.operations({ id });
    assert.equal(list.length, 2);
    assert.equal(list[0].original_native_id, list[1].original_native_id); assert(list[1].original_native_id);
    assert.equal(list[1].cwd, dir); assert.equal(list[1].status, 'completed', list[1].error);
    assert.equal(list[1].result?.text.trimEnd(), readFileSync(join(dir, '章表.csv'), 'utf8').trimEnd());
    return { id, cwd: dir, native: list[1].original_native_id, content: list[1].result.text };
  });
}

// Alternate just the owner's public report. Save only the in-process scenario's records at a settled boundary.
function forkPoint() {
  assert.equal(store.path, join(records, 'scenario.sqlite'));
  assert.equal(runtime.active.size, 0);
  const dbs = [store.db, ...[...runtime.inboxes.values()].map(i => i.store.db)];
  const snapshots = dbs.map(db => db.prepare('SELECT rowid, * FROM records ORDER BY rowid').all());
  const tables = [snow, coast].map(dir => [join(dir, '章表.csv'), readFileSync(join(dir, '章表.csv'), 'utf8')]);
  const actors = new Set(runtime.inboxes.keys());
  const beforeContexts = new Map(contexts);
  return () => {
    const charges = store.list('platform-usage');
    for (const [n, db] of dbs.entries()) {
      const rows = snapshots[n], fields = Object.keys(rows[0] ?? {});
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM records');
        if (fields.length) {
          const insert = db.prepare('INSERT INTO records(' + fields.join(',') + ') VALUES(' + fields.map(() => '?').join(',') + ')');
          for (const row of rows) insert.run(...fields.map(k => row[k]));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    for (const charge of charges) if (!store.get('platform-usage', charge.id)) store.import('platform-usage', charge);
    for (const [path, original] of tables) if (readFileSync(path, 'utf8') !== original) {
      log('branch_table_changed', { path, content: readFileSync(path, 'utf8') });
      writeFileSync(path, original);
    }
    for (const [id, box] of runtime.inboxes) if (!actors.has(id)) { runtime.inboxes.delete(id); box.store.close(); }
    contexts.clear(); for (const item of beforeContexts) contexts.set(...item);
  };
}
async function reportBranch(label, text) {
  stage = label;
  const begin = calls.length, count = realRequests;
  const prompt = send(B, '请把当前可以合入的章表和交付情况发在群里。');
  const report = script(label + '的负责人发言', planner, incoming(B, prompt.id), function* () {
    return yield say(B, text, { mentions: [egg] });
  });
  await settle();
  const sent = finished(report);
  const publicReplies = room.messages(B.id, user).filter(m => m.senderId === egg && m.sequence > sent.message.sequence)
    .map(m => ({ id: m.id, text: m.content, reply: m.replyTo, mentions: m.mentions }));
  log('followup_observation', { label, publicInput: sent.message.content, owner: planner, inputId: sent.message.id,
    deliveredToEgg: platform.messageDeliveries(sent.message.id).filter(d => d.bot_id === egg),
    modelRequests: realRequests - count, publicReplies, actions: calls.slice(begin).filter(c => c.actor === egg) });
  return { sent, publicReplies };
}
async function followups() {
  const restore = forkPoint();
  if (!scenarioOnly) {
    for (const [label, text] of [
      ['④ 用户才能定案', '稳妥线已写回 2。冒险线已按更正写好草稿 3；用户刚要求我在普通奖和限时奖两套发放方式中等他拍板，他还没有选。用户定了我就能补交，我仍负责。'],
      ['④ 缺主控的结算录像', '稳妥线已交 2，冒险线定为 3。群里原有的视频只拍到分岔，我缺结算画面。海岸主控今天已录下结算段，文件只有主控手里有。等他把这段补进群，我就能交齐。'],
      ['④ 原负责人不能继续', '稳妥线已交 2。冒险线的 3 和现有章表都已经交接清楚，我明确无法继续负责海岸章，也不能补这行；这项工作仍然要交。'],
    ]) {
      await test(label + '的实际观察', async () => { const branch = await reportBranch(label, text); return branch.publicReplies; });
      restore();
    }
  }
  const instruction = '把冒险线补回乙群原有章表，按本群更正写 3';
  const patch = script('乙群 Pi 接续补交', planner, onPi(planner, wb, instruction), function* () {
    return yield* writeTable(wb, content => { assert.equal(content, header + safeLine); return content + riskLine(3); });
  });
  let submission, addressed, promptId;
  const work = script('负责人沿原 Pi 补交', planner, frame => {
    if (frame.room !== B.id) return false;
    const publicCall = frame.events.find(v => v.type === 'current_event' && v.event.author.id === egg &&
      (v.event.mentions.includes(planner) || v.event.reply_to && room.read({ ref: eventRef(v.event.reply_to) }, user).senderId === planner));
    if (publicCall) addressed = publicCall.event.id;
    return Boolean(publicCall || promptId && frame.events.some(v => v.type === 'current_event' && v.event.id === promptId));
  }, function* () { submission = yield* resume(piB, instruction); return submission; });
  const published = script('按 Pi 终态回执公开交付', planner, f => f.room === B.id && submission?.call_id &&
    f.facts.some(v => v.type === 'call_result' && v.call_id === submission.call_id && v.status === 'completed'),
  function* () {
    const table = yield readTable(wb);
    assert.equal(table.content, header + safeLine + riskLine(3));
    const result = yield say(B, '本群项目 章表.csv 已交齐，稳妥线给 2，冒险线按更正给 3。程序对接和本轮反馈已结束。',
      { ...(addressed && { reply_to: eventRef(addressed) }), mentions: [egg] });
    return result.message;
  });
  const main = await reportBranch('④ 漏交冒险线', '海岸章首版已经交齐，可以合入。章表.csv 的全部记录为：海岸章，稳妥线，2。');
  stage = '④ 原成员补交';
  if (!work.started) {
    const follow = send(B, '策划请交回补齐后的同一份章表。', user);
    promptId = follow.id;
    log('directed_followup', { message: follow.id, report: main.sent.message.id });
  }
  await settle();
  await test('原成员接续原 Pi 把奖励 3 写到同一份章表', () => {
    finished(work); const content = finished(patch);
    assert.equal(readFileSync(join(coast, '章表.csv'), 'utf8'), content);
    return { planner, session: piB, content };
  });
  await test('交付回到乙群', () => {
    ownerDelivery = finished(published);
    const after = room.messages(B.id, user).filter(m => m.senderId === egg && m.sequence > ownerDelivery.sequence);
    return { owner: ownerDelivery.senderId, id: ownerDelivery.id, actualEggRequest: addressed, directed: promptId,
      closureReview: after.map(m => ({ id: m.id, text: m.content })) };
  });
}
function withTime(ms, fn) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [NativeDate.now() + ms])); }
    static now() { return NativeDate.now() + ms; }
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.Date = NativeDate; });
}
async function weekAndRemoval(includeRemoval = true) {
  stage = '⑤ 安静一周';
  const baseline = captured.length, count = realRequests;
  const membership = room.room(B.id, user).members;
  const base = store.list(wakeupRecords).find(w => w.bot_id === planner && w.rule.kind === 'room_base' && w.rule.room === B.id);
  const due = store.list(wakeupRecords).filter(w => w.enabled && w.next_due && w.next_due <= Date.now() + 7 * 86400000);
  const checkpoints = [...new Set([...due.map(w => Math.max(1, w.next_due - Date.now() + 1)), 7 * 86400000])].sort((a,b) => a-b);
  for (const checkpoint of checkpoints) await withTime(checkpoint, settle);
  await test('空闲一周的调度与留群', () => {
    assert.deepEqual(room.room(B.id, user).members, membership);
    assert(membership.includes(planner) && base.enabled && base.member_active);
    if (!due.length) assert.equal(captured.length, baseline);
    return { due: due.map(w => ({ id: w.id, bot: w.bot_id, at: w.next_due })), allProviderRequests: captured.length - baseline,
      externalRequests: realRequests - count, days: 7, originalSubscription: base.id };
  });
  stage = '⑤ 一周后回原群';
  // Stamp the new message and its responses at the advanced fixture time. The subscription and run IDs come from the runtime.
  await withTime(7 * 86400000, async () => {
    const change = send(B, '把冒险线奖励再加 1。', user, ownerDelivery ? { reply_to: eventRef(ownerDelivery.id) } : {});
    const task = '回到同一份海岸章表，冒险线奖励加 1';
    const patch = script('原 Pi 写 4', planner, onPi(planner, wb, task), function* () {
      return yield* writeTable(wb, content => { assert.equal(content, header + safeLine + riskLine(3)); return content.replace(riskLine(3), riskLine(4)); });
    });
    const response = script('原策划接一周后反馈', planner, incoming(B, change.id), function* () { return yield* resume(piB, task); });
    await settle();
    await test('同一成员和原群对话、原会话改 3 为 4', () => {
      finished(response); const content = finished(patch);
      const first = captured.find(f => f.bot === planner && f.room === B.id);
      const now = captured.find(f => f.bot === planner && f.room === B.id && f.events.some(e => e.type === 'current_event' && e.event.id === change.id));
      assert.equal(first.conversation, now.conversation);
      const delivery = platform.messageDeliveries(change.id).find(d => d.bot_id === planner);
      assert.equal(delivery.status, 'processed');
      assert.equal(readFileSync(join(coast, '章表.csv'), 'utf8'), content);
      return { planner, conversation: now.conversation, session: piB, message: change.id, time: change.createdAt, delivery: delivery.status, content };
    });
  });
  if (includeRemoval) await withTime(7 * 86400000, removal);
}
async function removal() {
  stage = '⑤ 用户明确移出';
  const oldPi = contexts.get(piB), oldRoom = contexts.get(planner + '/' + B.id);
  const oldNative = cliB && await invoke('read', { ref: ref('session', cliB) }, oldRoom);
  await hostTool('configure_room', { room: B, revision: room.room(B.id, user).revision, remove_members: [planner] });
  await test('原乙群 Pi 目录和外部接续被拒', async () => {
    assert(!room.room(B.id, user).members.includes(planner));
    const codes = [];
    const attempts = [
      ['乙群原 Pi 读章表', 'read', { ref: workRef(wb), path: '章表.csv' }, oldPi],
      ['乙群原 CLI 提交', 'send_input', { target: ref('session', cliB), kind: 'next', control_version: oldNative.control_version,
        input_target: oldNative.input_targets.find(t => t.kinds.includes('next')).input_target, input: '读章表' }, oldRoom],
    ];
    for (const [name, tool, args, ctx] of attempts) {
      let denial;
      try { await invoke(tool, args, { ...ctx, call_id: randomUUID() }); } catch (error) { denial = error; }
      assert(denial && [403,404,409].includes(denial.status) &&
        ['execution_not_found', 'session_authority_revoked', 'workspace_changed', 'workspace_forbidden', 'execution_paused',
          'execution_resources_forbidden','control_version_conflict','revision_conflict'].includes(denial.code), name + ': ' + (denial?.code || 'allowed'));
      codes.push({ name, code: denial.code, detail: denial.message });
    }
    assert.equal(readFileSync(join(coast, '章表.csv'), 'utf8'), header + safeLine + riskLine(4));
    return codes;
  });
  const msg = send(A, '请沿雪原原来的两个工作会话回读章表。');
  const task = '乙群移出之后回读雪原章表';
  const pa = script('保留甲群 Pi', planner, onPi(planner, wa, task), function* () { return (yield readTable(wa)).content; });
  const keep = script('保留甲群两种接续', planner, incoming(A, msg.id), function* () {
    yield* resume(piA, task); return yield* resume(cliA, '读章表');
  });
  await settle();
  await test('甲群同一人原 Pi 和 CLI 继续', () => {
    finished(keep); const val = finished(pa), op = connections.operations({ id: cliA }).at(-1);
    assert.equal(val, snowText + '雪原章,冰湖,8\n'); assert.equal(op.status, 'completed'); assert.equal(op.cwd, snow);
    assert.equal(op.result.text.trimEnd(), val.trimEnd());
    return { planner, piA, cliA, content: val, native: op.original_native_id };
  });
}
async function summaryReplay() {
  stage = '② 已有公共摘要的首次入群';
  const text = '海岸章分别提交稳妥线和冒险线。主控接程序，策划维护奖励表；早期冒险线口径已更正为 3。';
  const summary = room.savePublicSummary(B.id, user, null, corrected.id, text);
  assert.equal(summary.summary, text);
  await hostTool('configure_room', { room: B, revision: room.room(B.id, user).revision, add_members: [spare] });
  const msg = send(B, '请按本群正在使用的主线接手素材归档。', user, { mentions: [spare] });
  await settle();
  await test('既有公共摘要、旧成员和新人同一完整后缀', () => {
    const same = id => captured.find(f => f.stage === stage && f.bot === id && f.room === B.id && f.events.some(e => e.event.id === msg.id));
    const newcomer = same(spare), old = same(lead);
    assert.equal(captured.find(f => f.bot === spare && f.room === B.id), newcomer);
    const a = checkPublic(newcomer, B, snowOnly, summary), b = checkPublic(old, B, snowOnly, summary);
    assert.deepEqual(a.originals, b.originals); assert(a.originals.some(m => m.id === videoMessage.id));
    assert(!String(newcomer.system).includes(plannerPrivate));
    return { summary: a.summary, count: a.count, first: a.originals[0], through: a.through, lead: b.conversation, newcomer: a.conversation };
  });
}
async function settledWeek() {
  stage = '⑤ 收齐公开成果的独立分支';
  await hostTool('configure_room', { room: B, revision: room.room(B.id, user).revision, add_members: [planner] });
  const task = '按两条路线写回并回读本轮章表';
  const kickoff = send(B, '本轮交付为海岸章两条路线的章表和两人独立检查的录像第 1 秒。稳妥线给 2，冒险线给 3。主控负责核对读表，关卡策划接后续对奖励的反馈。',
    user, { attachments: [attachment.ref] });
  const pi = script('策划交付本轮章表', planner, onPi(planner, wb, task), function* () {
    return yield* writeTable(wb, before => { assert.equal(before, header); return before + safeLine + riskLine(3); });
  });
  const actors = [[lead, '主控'], [planner, '策划']];
  const extract = actors.map(([id, name]) => script('抽取待公开的帧-' + name, id, incoming(B, kickoff.id), function* () {
    if (id === planner) piB = (yield action('open_session', { engine: 'pi', input: task })).id;
    yield action('save_file', { space: workRef(wb), path: name + '-录像.mp4', content_or_source: { source: attachment.ref } });
    return yield action('open_session', { engine: toolsNew.id, input: name });
  }));
  await settle(); finished(pi);
  for (const [i, p] of extract.entries()) {
    finished(p); verifyFrame('新工具-' + actors[i][1] + '.png');
  }
  const collect = send(B, '请把各自实际抽取的帧和核对结果交在本群。');
  const reports = actors.map(([id, name]) => script('公开核对-' + name, id, incoming(B, collect.id), function* () {
    const table = yield readTable(wb);
    assert.equal(table.content, header + safeLine + riskLine(3));
    const file = yield action('save_file', { space: B, path: name + '-第1秒.png',
      content_or_source: { source: workRef(wb), path: '新工具-' + name + '.png' } });
    const text = id === planner ? '我核过录像第 1 秒的分岔位置，附上我的帧。章表.csv 已回读，海岸稳妥线 2、冒险线 3，反馈继续找我。' :
      '我已按字段读回了章表.csv 的两条路线，程序本轮需要的两条奖励为 2 和 3。我的第 1 秒抽帧随附，分岔可见。本轮读表对接已完成。';
    return (yield say(B, text, { attachments: [file.ref], reply_to: eventRef(collect.id) })).message;
  }));
  await settle();
  const items = reports.map(finished);
  ownerDelivery = items[1];
  assert(items.every(m => m.attachments.length === 1));
  realClosure = true;
  const close = send(B, '两位的帧和章表都收到，本轮验收完成，当前没有余项。后面几章的反馈我会回群找原负责人。', user,
    { mentions: [egg], references: items.map(m => eventRef(m.id)) });
  await settle();
  await test('两人公开交付、用户收齐后正常回看', () => {
    assert(realRequests > 0);
    const replies = room.messages(B.id, user).filter(m => m.senderId === egg && m.sequence > close.sequence).map(m => ({ id: m.id, text: m.content }));
    return { close: close.id, reports: items.map(m => ({ id: m.id, author: m.senderId, file: m.attachments[0].id })), replies };
  });
  await weekAndRemoval(false);
}
try {
  await setup();
  if (closedWeekOnly) await settledWeek();
  else {
    await kickoff();
    // Independent checks remain runnable when a preceding scene exposes a failure.
    for (const [label, fn] of [['执行场景', mediaAndSessions], ['交付场景', followups], ['接续与移出场景', weekAndRemoval],
      ['公共摘要场景', () => withTime(7 * 86400000, summaryReplay)]]) {
      try { await fn(); } catch (error) { results.push({ label, ok: false, error: error.message }); log('scenario_error', { label, error: error.stack }); }
    }
  }
} finally {
  log('end', { buildId, trace, realRequests, captured: captured.length,
    results: results.map(({ label, ok, error }) => ({ label, ok, error })) });
  await runtime.close(); await connections.close(); live.close(); store.close();
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
