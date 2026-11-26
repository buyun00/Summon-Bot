import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BotRuntime } from '../../bot/src/runtime/bot.mjs';
import { SummonPlatform } from '../../capabilities/platform/platform.mjs';
import { ChatroomService, messageEvent } from '../../capabilities/chatroom/service.mjs';
import { AttachmentStore } from '../../capabilities/chatroom/attachments.mjs';
import { activeControl } from '../../capabilities/bot-management/service.mjs';
import { installBundledBotFiles } from '../../capabilities/bot-management/folders.mjs';
import { identity, reject, user } from '../../capabilities/platform/contract.mjs';

export const eggId = 'bot-default-eggbot-local';

// Only the replay driver delivers messages or runs an agent. Public sends and
// new Bot identities still go through the normal platform and receive real receipts.
export class ReplayRuntime extends BotRuntime {
  wake() {}
}

export class ReplayPlatform extends SummonPlatform {
  scheduleFlush() {}

  acquireModel(input, options) {
    if (input.actor?.id !== eggId) throw new Error('Only EggBot may use a replay model connection');
    return super.acquireModel(input, options);
  }

  // All tools remain visible to the model. Workspace paths and host execution
  // have no backing implementation in a replay, including nested source refs.
  projectFileAccess() { reject('replay_workspace_unavailable', 'No host workspace is attached to this Room', 403); }
  workspaceAvailable() { return false; }
  workspace() { reject('replay_workspace_unavailable', 'No host workspace is attached to this Room', 403); }

  async invoke(name, args, context) {
    const op = name === 'find' ? 'find.' + args.kind :
      name === 'configure_room' && args.add_members?.length ? 'configure_room.add_members' : name;
    const fault = this.fixture.faults.find(item => item.operation === op);
    if (fault) reject('replay_injected_fault', fault.outcome, fault.outcome.includes('拒绝') ? 403 : 503);
    const allowed = ['send', 'read', 'find', 'save_file', 'create_bot', 'configure_room'];
    if (!allowed.includes(name) || (name === 'configure_room' && args.workspace != null) ||
        (name === 'create_bot' && args.bundled_id && !this.fixture.bundled_templates.some(b => b.bundled_id === args.bundled_id))) {
      reject('replay_tool_unavailable', 'This operation is not backed by the virtual room', 403);
    }
    return super.invoke(name, args, context);
  }
}

export function seedWorld({ platform, runtime, input, modelBinding, instructions, duty }) {
  const { store } = platform;
  platform.fixture = input.tool_fixture;
  const roomId = input.room.id;
  const space = { kind: 'room', id: roomId };
  const attachments = new AttachmentStore(join(platform.dataRoot, 'attachments'));
  platform.attachments = attachments;
  const room = new ChatroomService({ store, manager: platform.manager, attachments, platform });
  platform.attach({ room, runtime });

  // Dataset aliases may contain Unicode. Summon's real Bot folders use portable IDs.
  const aliases = new Map([['user', 'user'], ['egg', eggId]]);
  // Historical fixtures store engine readiness as an active template. Project it
  // into the current engine registry, with no detection or execution on the host.
  const engineIds = new Set(['codex', 'claude-code', 'grok-build']);
  platform.engines.detectCommand = () => null;
  platform.engines.ensureDefaults();
  for (const engine of platform.engines.list()) {
    const template = input.tool_fixture.bundled_templates.find(t => t.bundled_id === engine.id);
    platform.engines.setEnabled(engine.id, Boolean(template?.active_bot_id));
  }
  for (const entry of input.tool_fixture.bot_directory) {
    if (!aliases.has(entry.id)) aliases.set(entry.id, 'bot-replay-' + aliases.size);
    const isEgg = entry.id === 'egg';
    const historicalEngine = engineIds.has(entry.bundled_id);
    if (historicalEngine && !input.room.members.some(m => m.id === entry.id)) continue;
    const bundled = isEgg ? 'eggbot' : historicalEngine ? null : entry.bundled_id;
    const pkg = bundled && installBundledBotFiles(platform.releaseRoot, platform.dataRoot, bundled, aliases.get(entry.id));
    platform.manager.saveNew({
      id: aliases.get(entry.id), name: entry.name, owner: user,
      public_duty: isEgg ? duty : entry.public_duty, built_in_role: entry.built_in_role ?? null,
      ...(pkg && { bundled_id: bundled, model_provider: pkg.model_provider, engine_script: pkg.engine_script }),
      instructions: isEgg ? instructions : pkg?.instructions || '', model: isEgg ? modelBinding : null,
    });
  }
  const idOf = key => {
    const id = aliases.get(key);
    if (!id) throw new Error('Unknown fixture actor: ' + key);
    return id;
  };
  const actualCatalog = platform.manager.bundledCatalog();
  const templates = input.tool_fixture.bundled_templates.filter(template => !engineIds.has(template.bundled_id));
  platform.manager.bundledCatalog = () => templates.map(template => {
    const pkg = actualCatalog.find(item => item.id === template.bundled_id);
    const active = platform.manager.findByBundledId(template.bundled_id);
    return { ...pkg, id: template.bundled_id, name: template.name, installed: Boolean(active), bot_id: active?.id ?? null };
  });
  store.save('rooms', { id: roomId, name: input.room.name, mode: input.room.mode, revision: 1,
    lead_bot_id: idOf(input.room.lead_bot_id), members: input.room.members.map(m => idOf(m.id)), pins: [] });
  const initialMembers = [...store.get('rooms', roomId).members];
  const initialBots = new Set(platform.manager.list().map(bot => bot.id));
  const pendingIds = new Set(input.pending_message_ids);
  if (!pendingIds.size || !input.messages.length || input.messages.at(-1).id !== input.pending_message_ids.at(-1))
    throw new Error('The input must end at its pending decision');
  // Counterfactual messages can be inserted between two dated transcript rows.
  // Give them a time in transcript order so room reads see the same decision point.
  const firstDated = input.messages.findIndex(message => message.at);
  let previousTime = firstDated < 0 ? Date.now() - input.messages.length :
    Date.parse(input.messages[firstDated].at) - firstDated - 1;
  const messageAuthors = new Map();
  for (const msg of input.messages) {
    const senderId = idOf(msg.author_id);
    previousTime = Math.max(previousTime + 1, msg.at ? Date.parse(msg.at) : 0);
    store.save('messages', { id: msg.id, kind: 'message', roomId, senderId, author: identity(senderId),
      senderName: input.room.members.find(m => m.id === msg.author_id)?.name,
      content: msg.text, mentions: msg.mentions.map(idOf), replyTo: msg.reply_to ?? null,
      replyAuthorId: messageAuthors.get(msg.reply_to) ?? null,
      references: [], attachments: (msg.attachments || []).map((a, i) => ({ ...a, id: a.id || msg.id + '-attachment-' + i, unavailable: true })),
      createdAt: new Date(previousTime).toISOString() });
    messageAuthors.set(msg.id, senderId);
  }
  const events = room.messages(roomId, eggId).map(messageEvent);
  for (const event of events) store.save('platform-events', event);
  for (const session of input.active_sessions) {
    const owner = identity(idOf(session.owner_id));
    store.save('platform-sessions', { id: session.id, engine: session.engine, owner, execution_actor: owner,
      bot_id: owner.id, space, origin_room: space, origin_execution: { kind: 'conversation', id: 'replay-owner-' + owner.id },
      status: session.status, work_summary: session.summary, control: activeControl(), resource_refs: [], pending_input: [] });
  }
  return { room, space, aliases, initialMembers, initialBots, events: events.filter(e => pendingIds.has(e.id)),
    publishPeerActivities() {
      for (const a of input.peer_activities) platform.recordRoomActivity(roomId, {
        actor_id: idOf(a.actor_id), status: a.status, summary: a.summary, tool: a.tool,
      });
    } };
}

export async function loadEggProfile(hostRoot, instructionsPath) {
  const meta = JSON.parse(await readFile(join(hostRoot, 'bots', eggId, 'bot.json'), 'utf8'));
  if (meta.role_id !== 'eggbot' || !meta.model) throw new Error('Installed EggBot has no active model binding');
  return { modelBinding: meta.model, instructions: await readFile(instructionsPath, 'utf8'), duty: meta.public_duty };
}
