import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RecordStore } from '../../capabilities/shared/store.mjs';
import { ModelConnections } from '../../capabilities/models/service.mjs';
import { SummonPlatform } from '../../capabilities/platform/platform.mjs';
import { ChatroomService } from '../../capabilities/chatroom/service.mjs';
import { AttachmentStore } from '../../capabilities/chatroom/attachments.mjs';
import { BotRuntime } from '../../bot/src/runtime/bot.mjs';
import { BotStore } from '../../bot/src/storage/store.mjs';
import { Inbox } from '../../bot/src/storage/inbox.mjs';
import { activeControl } from '../../capabilities/bot-management/service.mjs';
import { writeBotFolderFile } from '../../capabilities/bot-management/folders.mjs';
import { keyOf, user } from '../../capabilities/platform/contract.mjs';

const releaseRoot = fileURLToPath(new URL('../../', import.meta.url));
const hostRoot = resolve(process.env.SUMMON_DATA_ROOT || join(releaseRoot, '../Relay-Bot-data'));

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'summon-s00-unit-'));
  const store = new RecordStore(':memory:');
  const models = new ModelConnections({ dataRoot: hostRoot });
  const platform = new SummonPlatform({ store, dataRoot, releaseRoot, models });
  const attachments = new AttachmentStore(join(dataRoot, 'attachments'));
  const room = new ChatroomService({ store, manager: platform.manager, attachments, platform });
  const runtime = new BotRuntime({ dataRoot, releaseRoot, platform, model: { connectionStore: models.path } });
  runtime.wake = () => {};
  platform.scheduleFlush = () => {};
  platform.attach({ room, runtime, exec: { open: async () => ({ status: 'completed', output: { text: 'ok' } }), inspect: async () => ({}), stop: async () => ({ status: 'stopped' }), drainStatus: async () => ({ active: [] }) } });
  platform.engines.detectCommand = () => null;
  platform.initializeDefaults();
  return { dataRoot, store, platform, room, runtime };
}

function makeBotContext(platform, botId, roomId) {
  const convId = randomUUID();
  const runId = randomUUID();
  const conv = platform.executions.registerConversation({
    id: convId,
    kind: 'room',
    bot_id: botId,
    space: { kind: 'room', id: roomId },
    owner: { kind: 'bot', id: botId },
  });
  const bot = platform.getBot(botId);
  return {
    actor: { kind: 'bot', id: botId },
    execution_actor: { kind: 'bot', id: botId },
    call_id: randomUUID(),
    controls: [
      { target: { kind: 'bot', id: botId }, control_version: bot.control.control_version },
      { target: { kind: 'conversation', id: conv.id }, control_version: conv.control.control_version },
    ],
    origin: {
      bot_id: botId,
      conversation_id: conv.id,
      run_id: runId,
      event_ids: [],
      control_version: conv.control.control_version,
      session_id: null,
    },
  };
}

async function main() {
  const { dataRoot, store, platform, room, runtime } = await setup();
  const results = [];
  const check = async (name, fn) => {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  };
  try {
    // Seed origin ops room
    const opsRoom = room.createRoom({ title: '线上服务运维', members: ['user'], lead_name: '运维指挥' }, 'user');
    const opsLeadId = opsRoom.lead_bot_id;
    const eggId = 'bot-default-eggbot-local';

    const inv = room.send(opsRoom.id, {
      text: '只读盘点显示，服务器 203.0.113.10 上运行着 TeslaMate 主服务、PostgreSQL、Mosquitto 容器，以及 teslamate-webhook.service。',
    }, opsLeadId);

    // Seed specialist created by opsLead
    const spCall = await platform.invoke('create_bot', {
      name: 'TeslaMate 守护员',
      public_duty: '监控 TeslaMate 健康并在掉线时告警恢复',
      instructions: '监控 TeslaMate 健康，避免唤醒车辆。',
    }, makeBotContext(platform, opsLeadId, opsRoom.id));
    const guardianId = spCall.id;

    // S00.1: group-lead calls create_room without listing itself + with lead_name + origin_room + opening_message
    let teslaRoom;
    await check('S00.1 group-lead create_room creates dedicated lead, does not force caller in, delivers opening_message', async () => {
      const ctx = makeBotContext(platform, opsLeadId, opsRoom.id);
      teslaRoom = await platform.invoke('create_room', {
        title: 'TeslaMate 行程与车辆守护',
        lead_name: '行程管家',
        lead_duty: '统筹行程总结与周末充电提醒',
        members: [{ kind: 'user', id: 'user' }, { kind: 'bot', id: guardianId }],
        origin_room: { kind: 'room', id: opsRoom.id },
        opening_message: {
          text: '由「线上服务运维」分化建群，服务器 203.0.113.10 已运行 TeslaMate 容器和 webhook。@TeslaMate 守护员 请先只读评估。',
          mentions: [{ kind: 'bot', id: guardianId }],
          references: [{ kind: 'event', id: inv.message.id }],
        },
      }, ctx);
      assert.equal(teslaRoom.mode, 'group', 'mode must default to group');
      assert.notEqual(teslaRoom.lead_bot_id, opsLeadId, 'must NOT hijack origin group-lead');
      assert.equal(teslaRoom.members.includes(opsLeadId), false, 'caller group-lead must NOT be forced into members');
      assert.equal(teslaRoom.members.includes(guardianId), true, 'specialist must be in new room');
      assert.equal(teslaRoom.members.includes(eggId), true, 'EggBot must be in new room');
      assert.equal(teslaRoom.origin_room?.id, opsRoom.id, 'origin_room must be preserved');
      const newLead = platform.getBot(teslaRoom.lead_bot_id);
      assert.equal(newLead.name, '行程管家', 'lead_name must be respected');
      assert.equal(newLead.public_duty, '统筹行程总结与周末充电提醒', 'lead_duty must be respected');
      assert.equal(newLead.home_room_id, teslaRoom.id, 'new lead home_room_id must match new room');
      const msgs = room.messages(teslaRoom.id, 'user');
      assert.equal(msgs.length, 1, 'opening_message should replace generic welcome');
      assert.equal(msgs[0].senderId, opsLeadId, 'opening_message must retain real author');
      const deliveries = platform.deliveries.deliveriesFor(msgs[0].id);
      const deliveredBots = new Set(deliveries.map(d => d.bot_id));
      assert.equal(deliveredBots.has(guardianId), true, 'opening_message must queue delivery to specialist');
      assert.equal(deliveredBots.has(teslaRoom.lead_bot_id), true, 'opening_message must queue delivery to new lead');
    });

    // S00.2: group-lead explicitly listed in members still does NOT hijack lead_bot_id
    await check('S00.2 foreign group-lead explicitly listed in members does not hijack lead_bot_id', async () => {
      const ctx = makeBotContext(platform, opsLeadId, opsRoom.id);
      const r2 = await platform.invoke('create_room', {
        title: '测试客座群',
        members: [{ kind: 'user', id: 'user' }, { kind: 'bot', id: opsLeadId }],
      }, ctx);
      assert.equal(r2.members.includes(opsLeadId), true, 'explicitly listed member should join');
      assert.notEqual(r2.lead_bot_id, opsLeadId, 'foreign group-lead with different home_room_id must NOT hijack lead_bot_id');
      assert.equal(platform.getBot(r2.lead_bot_id).home_room_id, r2.id);
    });

    // Add guardian to opsRoom too (dual-room specialist)
    const opsLatest = store.get('rooms', opsRoom.id);
    await platform.invoke('configure_room', {
      room: { kind: 'room', id: opsRoom.id },
      revision: opsLatest.revision,
      add_members: [{ kind: 'bot', id: guardianId }],
    }, makeBotContext(platform, eggId, opsRoom.id));

    // S00.3: Cross-room find(event) with query returns newest first + room_name + receipt output
    await check('S00.3 cross-room find(event) matches chat content and call.receipt stdout, newest first', async () => {
      const sessId = randomUUID();
      store.save('platform-sessions', {
        id: sessId, engine: 'exec', space: { kind: 'bot', id: opsLeadId }, owner: { kind: 'bot', id: opsLeadId },
        bot_id: opsLeadId, origin_room: { kind: 'room', id: opsRoom.id }, execution_actor: { kind: 'bot', id: opsLeadId },
        submitted_by: { kind: 'bot', id: opsLeadId }, work_summary: '补查运行中的容器服务', status: 'completed',
        latest_call_id: sessId, control: activeControl(), resource_refs: [], pending_input: [],
        created_at: '2026-11-26T02:36:15.000Z', updated_at: '2026-11-26T02:36:17.000Z',
      });
      const receiptEventId = keyOf('call', sessId, 'terminal:completed');
      store.save('platform-calls', {
        id: sessId, tool: 'open_session', submitted_by: { kind: 'bot', id: opsLeadId },
        execution_actor: { kind: 'bot', id: opsLeadId }, origin_bot: opsLeadId,
        target: { kind: 'session', id: sessId }, status: 'completed',
        result_ref: { kind: 'event', id: receiptEventId }, return_refs: [],
      });
      store.save('platform-events', {
        id: receiptEventId, kind: 'event', type: 'call.receipt', author: { kind: 'platform', id: 'platform' },
        call_id: sessId, target: { kind: 'session', id: sessId }, space: { kind: 'bot', id: opsLeadId },
        origin_room: { kind: 'room', id: opsRoom.id }, status: 'completed',
        result: { kind: 'call', id: sessId, status: 'completed', output: { text: 'teslamate-teslamate-1 Up 4 weeks' } },
        time: '2026-11-26T02:36:17.000Z',
      });

      const foundByGuardian = await platform.invoke('find', { kind: 'event', query: 'TeslaMate' }, makeBotContext(platform, guardianId, teslaRoom.id));
      assert.ok(foundByGuardian.items.length >= 2, 'guardian must find TeslaMate messages across BOTH rooms');
      assert.equal(foundByGuardian.items.some(it => it.roomId === opsRoom.id && it.room_name === '线上服务运维'), true, 'must find origin ops room message with room_name');
      assert.equal(foundByGuardian.items.some(it => it.roomId === teslaRoom.id), true, 'must find new tesla room message');

      const foundByOpsLead = await platform.invoke('find', { kind: 'event', query: 'teslamate-teslamate-1' }, makeBotContext(platform, opsLeadId, opsRoom.id));
      assert.equal(foundByOpsLead.items.some(it => it.id === receiptEventId), true, 'must match call.receipt stdout');

      // S00.4: find(session, query) matches work_summary AND receipt output
      const sessBySummary = await platform.invoke('find', { kind: 'session', query: '容器服务' }, makeBotContext(platform, opsLeadId, opsRoom.id));
      assert.equal(sessBySummary.items.some(s => s.id === sessId), true, 'find(session) must match work_summary');
      const sessByOutput = await platform.invoke('find', { kind: 'session', query: 'teslamate-teslamate-1' }, makeBotContext(platform, opsLeadId, opsRoom.id));
      assert.equal(sessByOutput.items.some(s => s.id === sessId), true, 'find(session) must match receipt stdout');

      // S00.5: find(conversation, query) matches room_name
      const convFound = await platform.invoke('find', { kind: 'conversation', query: '线上服务运维' }, makeBotContext(platform, opsLeadId, opsRoom.id));
      assert.ok(convFound.items.length >= 1 && convFound.items.every(c => c.room_name === '线上服务运维'), 'find(conversation) must match room_name');
    });

    // S00.6: EggBot handoff write to peer-created specialist .local/memory + read(bot, path:".local/memory") directory listing
    await check('S00.6 EggBot can write specialist .local/memory and read(bot, path:".local/memory") lists directory without 404', async () => {
      await platform.invoke('save_file', {
        space: { kind: 'bot', id: guardianId },
        path: '.local/memory/teslamate-env.md',
        content_or_source: '主机: 203.0.113.10\n容器: teslamate-teslamate-1, teslamate-database-1, teslamate-mosquitto-1',
      }, makeBotContext(platform, eggId, opsRoom.id));

      const memDir = await platform.invoke('read', {
        ref: { kind: 'bot', id: guardianId },
        path: '.local/memory',
      }, makeBotContext(platform, guardianId, teslaRoom.id));
      assert.equal(memDir.kind, 'directory');
      assert.ok(memDir.entries.some(e => e.path === '.local/memory/teslamate-env.md'));
      assert.ok(memDir.memory_items.some(m => m.note.includes('203.0.113.10')));

      const memDirSlash = await platform.invoke('read', {
        ref: { kind: 'bot', id: guardianId },
        path: '.local/memory/',
      }, makeBotContext(platform, guardianId, teslaRoom.id));
      assert.equal(memDirSlash.kind, 'directory');
    });

    // S00.7: contextBoundary injects room_origin and other_joined_rooms for multi-room specialist
    await check('S00.7 contextBoundary injects room_origin and other_joined_rooms for multi-room Bot', async () => {
      const inbox = new Inbox(new BotStore(':memory:'), guardianId);
      runtime.inboxes.set(guardianId, inbox);
      const conv = runtime.register(inbox, inbox.putConversation({
        id: randomUUID(),
        kind: 'room',
        space: { kind: 'room', id: teslaRoom.id },
        owner: { kind: 'bot', id: guardianId },
      }));
      const run = inbox.createRun(conv, []);
      const bot = platform.getBot(guardianId);
      const binding = runtime.binding(bot, conv);
      const job = runtime.job(inbox, conv, run, bot, binding, new AbortController());
      const boundary = await runtime.contextBoundary(job);
      const parsedFacts = boundary.facts.map(f => JSON.parse(f.content[0].text));
      const roomOrigin = parsedFacts.find(f => f.type === 'room_origin');
      const otherRooms = parsedFacts.find(f => f.type === 'other_joined_rooms');
      assert.equal(roomOrigin?.origin_room?.id, opsRoom.id, 'must inject room_origin');
      assert.equal(roomOrigin?.origin_room?.readable, true, 'guardian is in origin room so readable=true');
      assert.ok(otherRooms?.rooms?.some(r => r.id === opsRoom.id && r.name === '线上服务运维'), 'must inject other_joined_rooms with opsRoom');
    });

    // S00.8: Cross-room event references and room references in send/create_room
    await check('S00.8 send with room reference succeeds and cross-room event references are readable by new room lead', async () => {
      const opsMsg = room.send(opsRoom.id, { text: '原群关键盘点：ops-prod-01 端口 22' }, 'user').message;
      const derived = await platform.invoke('create_room', {
        title: '衍生共享验证群',
        members: [{ kind: 'user', id: 'user' }, { kind: 'bot', id: guardianId }],
        lead_name: '验证管家',
        origin_room: { kind: 'room', id: opsRoom.id },
        opening_message: {
          text: '交接原群盘点结论',
          references: [{ kind: 'event', id: opsMsg.id }],
        },
      }, makeBotContext(platform, eggId, opsRoom.id));

      const readByNewLead = await platform.invoke('read', {
        ref: { kind: 'event', id: opsMsg.id },
      }, makeBotContext(platform, derived.lead_bot_id, derived.id));
      assert.equal(readByNewLead.id, opsMsg.id, 'new room lead must read cross-room referenced event');
      assert.ok(readByNewLead.content.includes('ops-prod-01'));

      const sentWithRoomRef = await platform.invoke('send', {
        to: { kind: 'room', id: opsRoom.id },
        text: '已建衍生群',
        references: [{ kind: 'room', id: derived.id }],
      }, makeBotContext(platform, eggId, opsRoom.id));
      assert.ok(sentWithRoomRef.message?.id, 'send with room reference must succeed without operation_failed');
    });

    console.log(`\nALL ${results.length} S00 UNIT ASSERTIONS PASSED.`);
  } finally {
    try { await runtime.close(); } catch {}
    try { store.close(); } catch {}
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exitCode = 1;
});
