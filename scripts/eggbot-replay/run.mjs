import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordStore } from '../../capabilities/shared/store.mjs';
import { ModelConnections } from '../../capabilities/models/service.mjs';
import { tools } from '../../capabilities/platform/contract.mjs';
import { BotEngine } from '../../bot/src/agent/engine.mjs';
import { FastReadRuntime } from '../../bot/src/runtime/fast-read.mjs';
import { BotStore, runtimeRecords as R } from '../../bot/src/index.mjs';
import { Inbox } from '../../bot/src/storage/inbox.mjs';
import { ReplayPlatform, ReplayRuntime, eggId, seedWorld } from './world.mjs';

export async function replay(input, { hostRoot, releaseRoot, profile, signal, models = new ModelConnections({ dataRoot: hostRoot }) }) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'summon-egg-replay-'));
  let store, runtime;
  try {
    store = new RecordStore(':memory:');
    // The catalog resolves EggBot's existing purpose-specific connections.
    // No gateway, background model polling, or other bot runtime is started.
    const platform = new ReplayPlatform({ store, dataRoot, releaseRoot, models });
    const model = { connectionStore: models.path };
    const events = [];
    const emit = (type, data) => events.push({ type, data });
    runtime = new ReplayRuntime({ dataRoot, releaseRoot, platform, model, emit });
    const requests = new Map();
    const usage = { save(record) {
      const fields = ['id', 'purpose', 'botId', 'provider', 'connectionId', 'api', 'billingMode', 'model',
        'requestedModel', 'sentModel', 'responseModel', 'status', 'inputTokens', 'outputTokens', 'toolNames',
        'thinkingLevel', 'httpStatus', 'startedAt', 'finishedAt', 'providerFault', 'transportFailure', 'error'];
      requests.set(record.id, Object.fromEntries(fields.filter(key => key in record).map(key => [key, record[key]])));
    } };
    runtime.engine = new BotEngine({ platform, model, usage, toolSpecs: tools, clean: runtime.clean, emit });
    runtime.fastRead = new FastReadRuntime(runtime);
    const inbox = new Inbox(new BotStore(':memory:'), eggId);
    runtime.inboxes.set(eggId, inbox);
    const world = await seedWorld({ platform, runtime, input, ...profile });
    const initialEngines = platform.workEngines().map(engine => engine.id);
    const bot = platform.getBot(eggId);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    let run;
    const snapshot = () => {
      const calls = run ? inbox.calls(run.id).map(({tool, args, state, result}) => ({ tool, args, state, result })) : [];
      const bots = platform.manager.list();
      const member = id => ({ id, name: bots.find(bot => bot.id === id)?.name ?? id });
      const after = store.get('rooms', input.room.id).members;
      return { case: input.id, modelRequests: [...requests.values()], calls,
        decisions: inbox.store.listRecords(R.route).map(r => ({ message: r.event_id, route: r.fast_read_decision })),
        workEngines: { before: initialEngines, after: platform.workEngines().map(engine => engine.id) },
        newBots: bots.filter(b => !world.initialBots.has(b.id)).map(({id,name,public_duty,bundled_id}) => ({id,name,public_duty,bundled_id})),
        initialMembers: world.initialMembers.map(member), finalMembers: after.map(member),
        addedMembers: after.filter(id => !world.initialMembers.includes(id)).map(member),
        removedMembers: world.initialMembers.filter(id => !after.includes(id)),
        messages: world.room.messages(input.room.id, eggId).filter(m => m.senderId === eggId && !input.messages.some(old => old.id === m.id))
          .map(({content,mentions,replyTo,prompt,attachments}) => ({text:content,mentions,replyTo,prompt,attachments})),
        files: store.list('platform-files').map(({path, content, space}) => ({path, content, space})),
        aliases:Object.fromEntries(world.aliases) };
    };
    try {
      for (const event of world.events) {
        inbox.receive({ id: 'delivery-' + event.id, bot_id: eggId, event,
          match_sources: [{ kind: 'room_base', id: 'replay-room-membership', revision: 1 }] });
      }
      await runtime.fastRead.runBatch(inbox, bot, input.room.id, inbox.pending(), controller);
      controller.signal.throwIfAborted();
      const fallback = events.find(e => e.type === 'fast_read.fallback');
      if (fallback) throw new Error('Fast-read fallback: ' + fallback.data.reason);
      const decisions = inbox.store.listRecords(R.route).map(r => ({ message: r.event_id, route: r.fast_read_decision }));
      if (decisions.length !== input.pending_message_ids.length || decisions.some(d => !['main','quiet'].includes(d.route)))
        throw new Error('Fast-read did not settle every target');
      const pending = inbox.pending();
      if (pending.length) {
        const conversation = runtime.register(inbox, inbox.putConversation({ id: randomUUID(), kind: 'room',
          space: world.space, owner: { kind: 'bot', id: eggId } }));
        run = inbox.createRun(conversation, pending);
        const binding = runtime.binding(bot, conversation);
        const job = runtime.job(inbox, conversation, run, bot, binding, controller);
        world.publishPeerActivities();
        const outcome = await runtime.engine.execute(job);
        if (!pending.every(route => outcome?.eventIds.includes(route.event_id))) throw new Error('Main turn did not consume the target');
        inbox.complete(run.id, 'completed', outcome.eventIds);
      }
      const report = snapshot();
      const succeeded = purpose => report.modelRequests.some(r => r.purpose === purpose && r.status === 'succeeded');
      if (!succeeded('fast_read') || (pending.length && !succeeded('conversation')) ||
          report.modelRequests.some(r => r.botId !== eggId)) throw new Error('Incomplete or unexpected model execution');
      return report;
    } catch (error) {
      error.observed = snapshot();
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  } finally {
    try { await runtime?.close(); } finally {
      try { store?.close(); } finally { await rm(dataRoot, { recursive: true, force: true, maxRetries: 3 }); }
    }
  }
}
