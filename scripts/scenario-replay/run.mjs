import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { RecordStore } from '../../capabilities/shared/store.mjs';
import { ModelConnections } from '../../capabilities/models/service.mjs';
import { SummonPlatform } from '../../capabilities/platform/platform.mjs';
import { ChatroomService } from '../../capabilities/chatroom/service.mjs';
import { AttachmentStore } from '../../capabilities/chatroom/attachments.mjs';
import { BotRuntime } from '../../bot/src/runtime/bot.mjs';
import { activeControl } from '../../capabilities/bot-management/service.mjs';
import { listBotMemoryItems } from '../../capabilities/bot-management/folders.mjs';
import { keyOf, identity, user } from '../../capabilities/platform/contract.mjs';
import { runtimeRecords as R } from '../../bot/src/storage/runtime-records.mjs';

const releaseRoot = fileURLToPath(new URL('../../', import.meta.url));
const hostRoot = resolve(process.env.SUMMON_DATA_ROOT || join(releaseRoot, '../Relay-Bot-data'));

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: 'string' },
    out: { type: 'string' },
    timeout: { type: 'string' },
  },
});

const suitePath = resolve(opts.suite || join(releaseRoot, 'docs/scenario-replay/ops-teslamate-differentiation.json'));
const stageTimeoutMs = Number(opts.timeout || 240_000);
const selectedIds = positionals.length ? new Set(positionals) : null;

function createMockExec(platform, mockRules = []) {
  const execCalls = [];
  return {
    execCalls,
    async open({ session, call, input, beforeSubmit }) {
      await beforeSubmit();
      const shell = typeof input?.shell === 'string' ? input.shell : JSON.stringify(input ?? '');
      const rule = mockRules.find(r => new RegExp(r.match, 'i').test(shell));
      const stdout = rule ? rule.stdout : 'ok\n';
      execCalls.push({ session_id: session.id, call_id: call.id, bot_id: session.owner?.id, work_summary: session.work_summary, shell, stdout });
      const facts = {
        status: 'completed',
        session_status: 'completed',
        exit_code: 0,
        safe_to_disconnect: true,
        output: { text: stdout, stdout, stderr: '', exit_code: 0 },
        native: { protocol: 'mock-replay', pid: 0, session_id: null },
      };
      setImmediate(() => {
        try {
          platform.executions.receipt(session.id, call.id, {
            ...facts,
            position: keyOf('exec', session.id, 'terminal:completed'),
          });
        } catch {}
      });
      return {
        status: 'running',
        can_steer: false,
        can_continue: false,
        safe_to_disconnect: false,
        native: { protocol: 'mock-replay', pid: 0, session_id: null },
      };
    },
    async inspect(session) {
      const rec = execCalls.find(item => item.session_id === session.id);
      return rec ? { status: 'completed', safe_to_disconnect: true, output: { text: rec.stdout, stdout: rec.stdout, stderr: '' } } : { status: session.status, safe_to_disconnect: true };
    },
    async input() { return { status: 'completed', safe_to_disconnect: true }; },
    async stop() { return { status: 'stopped', safe_to_disconnect: true }; },
    async drainStatus() { return { active: [] }; },
  };
}

function hasPendingWork(platform, runtime) {
  if (runtime.active.size > 0 || runtime.starting.size > 0 || runtime.fastRead.active.size > 0) return true;
  if (platform.deliveries.flushing) return true;
  const deliveries = platform.store.list('platform-deliveries');
  if (deliveries.some(d => ['pending', 'unknown', 'received'].includes(d.status))) return true;
  for (const inbox of runtime.inboxes.values()) {
    if (inbox.pending().length > 0) return true;
    const runs = inbox.store.listRecords(R.run);
    if (runs.some(r => ['pending', 'running', 'waiting', 'retry'].includes(r.state))) return true;
  }
  return false;
}

async function settleAll(platform, runtime, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await platform.deliveries.flush(runtime);
    await runtime.pump();
    await new Promise(r => setTimeout(r, 250));
    if (!hasPendingWork(platform, runtime)) {
      stableTicks++;
      if (stableTicks >= 4) return { settled: true };
    } else {
      stableTicks = 0;
    }
  }
  return { settled: false, reason: 'timeout' };
}

function collectBotTelemetry(platform, runtime) {
  const out = {};
  for (const bot of platform.manager.list()) {
    const inbox = runtime.inboxes.get(bot.id);
    const calls = inbox
      ? inbox.store.listRecords(R.call)
          .sort((a, b) => String(a.prepared_at || '').localeCompare(String(b.prepared_at || '')))
          .map(c => ({
            tool: c.tool,
            state: c.state,
            args: c.args,
            error_code: c.result?.code || null,
            result_summary: c.tool === 'find'
              ? { count: c.result?.items?.length ?? null, ids: (c.result?.items || []).slice(0, 6).map(i => i.id) }
              : c.tool === 'read'
                ? { kind: c.result?.kind || c.result?.room?.id || c.result?.path || null, code: c.result?.code || null }
                : c.tool === 'create_room'
                  ? { id: c.result?.id, name: c.result?.name, lead_bot_id: c.result?.lead_bot_id, members: c.result?.members }
                  : c.tool === 'create_bot'
                    ? { id: c.result?.id, name: c.result?.name, public_duty: c.result?.public_duty }
                    : c.tool === 'send'
                      ? { id: c.result?.message?.id, to: c.args?.to, text: c.args?.text?.slice(0, 200), has_prompt: Boolean(c.args?.prompt) }
                      : { status: c.result?.status || c.state },
          }))
      : [];
    const routes = inbox
      ? inbox.store.listRecords(R.route).map(r => ({ event_id: r.event_id, state: r.state, fast_read: r.fast_read_decision || null }))
      : [];
    const runs = inbox
      ? inbox.store.listRecords(R.run).map(r => ({ id: r.id, state: r.state, error: r.error || null }))
      : [];
    out[bot.id] = {
      id: bot.id,
      name: bot.name,
      role_id: bot.built_in_role?.id || null,
      home_room_id: bot.home_room_id || null,
      public_duty: bot.public_duty,
      memory_items: listBotMemoryItems(platform.dataRoot, bot.id),
      routes,
      runs,
      calls,
    };
  }
  return out;
}

function asksForDeployment(msg) {
  const parts = [msg.content || ''];
  if (msg.prompt?.title) parts.push(msg.prompt.title);
  for (const q of msg.prompt?.questions || []) {
    if (q.label) parts.push(q.label);
    if (q.hint) parts.push(q.hint);
  }
  const full = parts.join('\n');
  return /(部署在哪|部署位置|采用什么方式|请提供.*(部署|连接|会话|记录引用|访问入口)|尚未取得部署信息|未找到.*连接)/.test(full);
}

function hasDeploymentEvidence(text) {
  return /(203\.0\.113\.10|ops-prod-01|teslamate-teslamate-1|teslamate-database-1|teslamate-mosquitto-1|teslamate-webhook|postgresql|mosquitto|阿里云|docker|ssh)/i.test(text || '');
}

async function runCase(suite, testCase) {
  const dataRoot = await mkdtemp(join(tmpdir(), `summon-scenario-${testCase.id}-`));
  const store = new RecordStore(':memory:');
  const models = new ModelConnections({ dataRoot: hostRoot });
  const attachments = new AttachmentStore(join(dataRoot, 'attachments'));
  const platform = new SummonPlatform({ store, dataRoot, releaseRoot, models, attachments });
  const room = new ChatroomService({ store, manager: platform.manager, attachments, platform });
  const runtime = new BotRuntime({ dataRoot, releaseRoot, platform, model: { connectionStore: models.path } });
  const mockExec = createMockExec(platform, suite.shared_seed.mock_exec_responses);
  platform.attach({ room, runtime, exec: mockExec });
  platform.engines.detectCommand = () => null;
  await runtime.initialize();
  if (runtime.interval) clearInterval(runtime.interval);
  platform.initializeDefaults();

  const seed = suite.shared_seed;
  const eggId = 'bot-default-eggbot-local';
  const opsLeadCfg = seed.ops_room.lead_bot;
  const opsRoomId = seed.ops_room.id;

  try {
    // 1. Create ops lead & ops room directly in store (avoiding welcome message & keeping exact IDs)
    platform.manager.saveNew({
      id: opsLeadCfg.id,
      name: opsLeadCfg.name,
      instructions: opsLeadCfg.instructions || '',
      public_duty: opsLeadCfg.public_duty,
      model: { mode: 'follow_default' },
      owner: user,
      built_in_role: { id: 'group-lead' },
      home_room_id: opsRoomId,
    });
    const opsMembers = ['user', opsLeadCfg.id, eggId];

    // Optional preseeded bots
    if (testCase.preseed_specialist) {
      const sp = testCase.preseed_specialist;
      platform.manager.saveNew({
        id: sp.id, name: sp.name, instructions: sp.instructions || '',
        public_duty: sp.public_duty, model: { mode: 'follow_default' }, owner: user,
      });
      opsMembers.push(sp.id);
    }
    if (testCase.preseed_offroom_specialist) {
      const sp = testCase.preseed_offroom_specialist;
      platform.manager.saveNew({
        id: sp.id, name: sp.name, instructions: sp.instructions || '',
        public_duty: sp.public_duty, model: { mode: 'follow_default' }, owner: user,
      });
    }

    store.save('rooms', {
      id: opsRoomId,
      name: seed.ops_room.name,
      members: opsMembers,
      mode: 'group',
      pins: [],
      revision: 2,
      lead_bot_id: opsLeadCfg.id,
      workspace: null,
      createdAt: '2026-11-26T02:27:55.428Z',
      updatedAt: '2026-11-26T02:27:58.777Z',
    });
    for (const member of opsMembers) if (member !== 'user') platform.ensureRoomBase(member, opsRoomId);

    // Seed historical messages directly (no delivery triggered for pre-trigger history)
    const authorById = new Map();
    for (const m of seed.messages) {
      const senderName = m.author_id === 'user' ? '宿主' : platform.getBot(m.author_id).name;
      store.save('messages', {
        id: m.id, kind: 'message', roomId: opsRoomId, senderId: m.author_id, senderName,
        author: identity(m.author_id), content: m.text, attachments: [], references: [],
        mentions: m.mentions || [], replyTo: m.reply_to || null,
        ...(m.reply_to ? { replyAuthorId: authorById.get(m.reply_to) || null } : {}),
        createdAt: m.at,
      });
      authorById.set(m.id, m.author_id);
    }

    // Seed historical exec sessions + receipts
    for (const hs of seed.historical_sessions) {
      const owner = { kind: 'bot', id: hs.owner_bot_id };
      const receiptEventId = keyOf('call', hs.id, 'terminal:completed');
      store.save('platform-sessions', {
        id: hs.id, engine: hs.engine, space: owner, owner, bot_id: hs.owner_bot_id,
        origin_room: { kind: 'room', id: hs.origin_room_id }, origin_message_id: hs.origin_message_id,
        execution_actor: owner, submitted_by: owner, work_summary: hs.work_summary,
        status: hs.status, latest_call_id: hs.id, control: activeControl(),
        resource_refs: [], pending_input: [], created_at: hs.created_at, updated_at: hs.updated_at,
      });
      store.save('platform-calls', {
        id: hs.id, tool: 'open_session', submitted_by: owner, execution_actor: owner,
        origin_bot: hs.owner_bot_id, target: { kind: 'session', id: hs.id },
        status: hs.status, result_ref: { kind: 'event', id: receiptEventId }, return_refs: [],
        created_at: hs.created_at,
      });
      store.save('platform-events', {
        id: receiptEventId, kind: 'event', type: 'call.receipt',
        author: { kind: 'platform', id: 'platform' }, call_id: hs.id,
        target: { kind: 'session', id: hs.id }, space: owner,
        origin_room: { kind: 'room', id: hs.origin_room_id }, origin_message_id: hs.origin_message_id,
        status: hs.status, result: { kind: 'call', id: hs.id, status: hs.status, output: { text: hs.output_text } },
        time: hs.updated_at,
      });
    }

    // Optional preseeded second room (S02)
    if (testCase.preseed_second_room) {
      const sr = testCase.preseed_second_room;
      room.createRoom({
        title: sr.name,
        lead_name: sr.lead_name,
        lead_duty: sr.lead_duty,
        members: ['user', testCase.preseed_specialist.id],
        origin_room: { kind: 'room', id: opsRoomId },
        skip_welcome: true,
      }, 'user', { id: sr.id });
    }

    const initialBotIds = new Set(platform.manager.list().map(b => b.id));
    const initialRoomIds = new Set(store.list('rooms').map(r => r.id));

    const stageLogs = [];
    let discoveredNewRoomId = null;

    for (const stage of testCase.stages) {
      let targetRoomId = stage.room;
      if (targetRoomId === '$new_room') {
        const createdRooms = store.list('rooms').filter(r => !initialRoomIds.has(r.id) && r.mode === 'group');
        discoveredNewRoomId = createdRooms[0]?.id || null;
        if (!discoveredNewRoomId) {
          stageLogs.push({ stage: stage.id, skipped: true, reason: 'no_new_room_created' });
          break;
        }
        targetRoomId = discoveredNewRoomId;
      }
      const beforeSeq = room.latestSequence(targetRoomId);
      const sent = room.send(targetRoomId, {
        text: stage.user_text,
        mentions: stage.mention_bot_ids || [],
      }, 'user');
      console.error(`[${testCase.id}] Running ${stage.id} in ${targetRoomId}...`);
      const settled = await settleAll(platform, runtime, stageTimeoutMs);
      const allMsgs = room.messages(targetRoomId, 'user');
      const newMsgs = allMsgs.filter(m => m.sequence > beforeSeq);
      stageLogs.push({
        stage: stage.id,
        room_id: targetRoomId,
        sent_message_id: sent.message.id,
        settled,
        new_messages: newMsgs.map(m => ({
          id: m.id, senderId: m.senderId, senderName: m.senderName || (m.senderId === 'user' ? '宿主' : platform.store.get('platform-bots', m.senderId)?.name),
          content: m.content, mentions: m.mentions, prompt: m.prompt || null,
        })),
      });
    }

    // Build snapshot
    const finalRooms = store.list('rooms').map(r => ({
      id: r.id,
      name: r.name,
      mode: r.mode,
      lead_bot_id: r.lead_bot_id || null,
      origin_room: r.origin_room || null,
      members: r.members,
      messages: room.messages(r.id, 'user').map(m => ({
        id: m.id, senderId: m.senderId,
        senderName: m.senderName || (m.senderId === 'user' ? '宿主' : platform.store.get('platform-bots', m.senderId)?.name),
        content: m.content, mentions: m.mentions, references: m.references, prompt: m.prompt || null,
      })),
    }));
    const newRooms = finalRooms.filter(r => !initialRoomIds.has(r.id) && r.mode === 'group');
    const finalBots = platform.manager.list();
    const newBots = finalBots.filter(b => !initialBotIds.has(b.id));
    const newLeadBots = newBots.filter(b => b.built_in_role?.id === 'group-lead');
    const newSpecialistBots = newBots.filter(b => b.built_in_role?.id !== 'group-lead');
    const telemetry = collectBotTelemetry(platform, runtime);

    // Evaluate assertions per case kind
    const assertions = [];
    const assertCond = (id, pass, detail) => assertions.push({ id, pass: Boolean(pass), detail });

    if (testCase.kind === 'full_differentiation') {
      const opsFinal = finalRooms.find(r => r.id === opsRoomId);
      const newRoom = newRooms[0] || null;
      const specialist = newSpecialistBots[0] || null;

      assertCond('exact_one_new_room', newRooms.length === 1, `newRooms=${newRooms.length} (${newRooms.map(r => r.name).join(', ')})`);
      assertCond('exact_one_new_specialist', newSpecialistBots.length === 1, `newSpecialists=${newSpecialistBots.length} (${newSpecialistBots.map(b => b.name).join(', ')})`);
      assertCond('independent_new_lead', Boolean(newRoom && newRoom.lead_bot_id && newRoom.lead_bot_id !== opsLeadCfg.id && platform.getBot(newRoom.lead_bot_id)?.home_room_id === newRoom.id),
        `newRoom.lead=${newRoom?.lead_bot_id} (opsLead=${opsLeadCfg.id})`);
      assertCond('ops_lead_not_hijacked_into_new_room', Boolean(newRoom && !newRoom.members.includes(opsLeadCfg.id)),
        `newRoom.members=${JSON.stringify(newRoom?.members)}`);
      assertCond('specialist_in_both_rooms', Boolean(specialist && newRoom && opsFinal.members.includes(specialist.id) && newRoom.members.includes(specialist.id)),
        `specialist=${specialist?.id}, inOps=${opsFinal?.members.includes(specialist?.id)}, inNew=${newRoom?.members.includes(specialist?.id)}`);

      const specialistMemoryText = specialist ? listBotMemoryItems(dataRoot, specialist.id).map(m => m.note).join('\n') : '';
      const newRoomOpeningText = newRoom ? newRoom.messages.slice(0, 2).map(m => m.content).join('\n') : '';
      const handoffPool = `${specialistMemoryText}\n${newRoomOpeningText}\n${specialist?.instructions || ''}`;
      assertCond('handoff_carries_deployment_facts', hasDeploymentEvidence(handoffPool),
        `memoryCount=${specialist ? listBotMemoryItems(dataRoot, specialist.id).length : 0}, openingLen=${newRoomOpeningText.length}`);

      const newRoomBotMsgs = newRoom ? newRoom.messages.filter(m => m.senderId !== 'user') : [];
      const askedDeployment = newRoomBotMsgs.filter(asksForDeployment);
      assertCond('new_room_never_reasks_deployment', askedDeployment.length === 0,
        askedDeployment.length ? `re-asked in: ${askedDeployment.map(m => m.content.slice(0, 120)).join(' | ')}` : 'no redundant deployment questions');

      const stage2 = stageLogs.find(s => s.stage === 'stage2_new_room_followup');
      const stage2BotText = (stage2?.new_messages || []).filter(m => m.senderId !== 'user').map(m => m.content).join('\n');
      assertCond('stage2_proceeds_with_known_env', Boolean(stage2 && !stage2.skipped && stage2BotText.length > 0 && hasDeploymentEvidence(stage2BotText)),
        `stage2ReplyLen=${stage2BotText.length}`);

      const stage3 = stageLogs.find(s => s.stage === 'stage3_origin_room_cross_call');
      const stage3SpecialistMsgs = (stage3?.new_messages || []).filter(m => specialist && m.senderId === specialist.id);
      const stage3SpecialistText = stage3SpecialistMsgs.map(m => m.content).join('\n');
      assertCond('stage3_same_specialist_responds_in_ops_room', stage3SpecialistMsgs.length > 0,
        `specialistRepliesInOps=${stage3SpecialistMsgs.length}, allStage3Senders=${JSON.stringify((stage3?.new_messages || []).map(m => m.senderId))}`);
      assertCond('stage3_carries_notification_context', /(本群|群里|TeslaMate.*群|通知|告警)/i.test(stage3SpecialistText),
        `stage3SpecialistText=${stage3SpecialistText.slice(0, 200)}`);

      const any404Memory = Object.values(telemetry).some(b => b.calls.some(c => c.tool === 'read' && c.error_code === 'file_not_found' && String(c.args?.path || '').includes('.local/memory')));
      assertCond('zero_404_on_memory_dir', !any404Memory, `any404Memory=${any404Memory}`);
    } else if (testCase.kind === 'cross_room_recall') {
      const spId = testCase.preseed_specialist.id;
      const spTel = telemetry[spId];
      const stage1 = stageLogs[0];
      const spMsgs = (stage1?.new_messages || []).filter(m => m.senderId === spId);
      const replyText = spMsgs.map(m => m.content).join('\n');
      const usedCrossLookup = spTel?.calls?.some(c =>
        (c.tool === 'find' && ['event', 'room', 'session'].includes(c.args?.kind)) ||
        (c.tool === 'read' && c.args?.ref?.kind === 'room' && c.args?.ref?.id === opsRoomId));
      assertCond('specialist_used_cross_room_lookup', Boolean(usedCrossLookup), `calls=${JSON.stringify(spTel?.calls?.map(c => `${c.tool}:${c.args?.kind || c.args?.ref?.kind}`))}`);
      assertCond('zero_404_errors', !spTel?.calls?.some(c => c.error_code === 'file_not_found'), 'no 404 tool errors');
      assertCond('recalled_host_and_services', /203\.0\.113\.10|ops-prod-01/.test(replyText) && /teslamate/i.test(replyText) && /(webhook|mosquitto|postgres)/i.test(replyText),
        `reply=${replyText.slice(0, 300)}`);
      assertCond('never_asked_user_for_deployment', !spMsgs.some(asksForDeployment), 'no redundant deployment prompt');
    } else if (testCase.kind === 'no_over_differentiation') {
      assertCond('no_new_room_created', newRooms.length === 0, `newRooms=${newRooms.length}`);
      assertCond('no_new_bot_created', newBots.length === 0, `newBots=${newBots.length}`);
      const eggTel = telemetry[eggId];
      const eggSent = eggTel?.calls?.some(c => c.tool === 'send');
      assertCond('eggbot_stayed_silent', !eggSent, `eggSent=${Boolean(eggSent)}`);
      const stage1 = stageLogs[0];
      const leadReplied = (stage1?.new_messages || []).some(m => m.senderId === opsLeadCfg.id);
      assertCond('ops_lead_answered_directly', leadReplied, `leadReplied=${leadReplied}`);
    } else if (testCase.kind === 'reuse_existing_specialist') {
      const existingId = testCase.preseed_offroom_specialist.id;
      const opsFinal = finalRooms.find(r => r.id === opsRoomId);
      const newRoom = newRooms[0] || null;
      assertCond('exact_one_new_room', newRooms.length === 1, `newRooms=${newRooms.length}`);
      assertCond('no_duplicate_specialist_created', newSpecialistBots.length === 0, `newSpecialists=${newSpecialistBots.map(b => b.name).join(', ')}`);
      assertCond('independent_new_lead', Boolean(newRoom && newRoom.lead_bot_id !== opsLeadCfg.id && platform.getBot(newRoom.lead_bot_id)?.home_room_id === newRoom.id),
        `newRoom.lead=${newRoom?.lead_bot_id}`);
      assertCond('existing_specialist_in_both_rooms', Boolean(newRoom && opsFinal.members.includes(existingId) && newRoom.members.includes(existingId)),
        `inOps=${opsFinal?.members.includes(existingId)}, inNew=${newRoom?.members.includes(existingId)}`);
    }

    const passed = assertions.every(a => a.pass);
    return {
      case: testCase.id,
      name: testCase.name,
      passed,
      assertions,
      summary: {
        newRooms: newRooms.map(r => ({ id: r.id, name: r.name, lead_bot_id: r.lead_bot_id, origin_room: r.origin_room, members: r.members })),
        newBots: newBots.map(b => ({ id: b.id, name: b.name, role_id: b.built_in_role?.id || null, home_room_id: b.home_room_id || null, public_duty: b.public_duty })),
        opsMembers: finalRooms.find(r => r.id === opsRoomId)?.members || [],
        execCalls: mockExec.execCalls.length,
      },
      stages: stageLogs,
      rooms: finalRooms,
      telemetry,
    };
  } finally {
    try { await runtime.close(); } catch {}
    try { store.close(); } catch {}
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main() {
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
  const cases = selectedIds ? suite.cases.filter(c => selectedIds.has(c.id)) : suite.cases;
  if (!cases.length) throw new Error('No matching cases selected');
  const results = [];
  for (const c of cases) {
    const res = await runCase(suite, c);
    results.push(res);
    console.log(`\n==================== ${res.case}: ${res.passed ? 'PASS' : 'FAIL'} (${res.name}) ====================`);
    for (const a of res.assertions) {
      console.log(`  [${a.pass ? 'PASS' : 'FAIL'}] ${a.id}: ${a.detail}`);
    }
  }
  if (opts.out) {
    const outPath = resolve(opts.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ suite: suite.suite, ran_at: new Date().toISOString(), results }, null, 2), 'utf8');
    console.error(`Report saved to ${outPath}`);
  }
  const allPassed = results.every(r => r.passed);
  console.log(`\nSUMMARY: ${results.filter(r => r.passed).length}/${results.length} cases passed.`);
  if (!allPassed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
