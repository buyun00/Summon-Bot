import { botMaintenanceLeadId, eggbotRole, defaultPublicDuty, groupLeadRole } from './roles.mjs';
import { botRootDir, ensureBotFolder, installBundledBotFiles, listBotFolderFiles, listBundledBots, readBotFolderMeta, readBotInstructions, syncBotMetaFiles } from './folders.mjs';
import { defaultPaperAvatar, normalizePaperAvatar } from '../shared/avatar-style.mjs';
import { assertRevision, idOf, reject, sameIdentity, user } from '../platform/contract.mjs';

export const botRecords = 'platform-bots';
export const deletedBotRecords = 'deleted-bots';
const isProtectedSystemBot = id => id === 'bot-default-eggbot-local' || id === botMaintenanceLeadId;

export function activeControl() {
  return { state: 'active', control_version: 1, stop_id: null, requested_by: null, stop_status: null };
}

export function canResume(actor, control, owner) {
  return actor.kind === 'user' || sameIdentity(actor, control?.requested_by) ||
    (control?.requested_by?.kind !== 'user' && sameIdentity(actor, owner));
}

function cleanName(name) {
  const value = name?.trim();
  if (!value || value.length > 100) reject('invalid_name', 'Bot name must contain 1–100 characters');
  return value;
}

function instructionsOf(value) {
  if (typeof value !== 'string' || value.length > 100_000) reject('invalid_instructions', 'Invalid Bot instructions');
  return value;
}

function publicDuty(value) {
  if (typeof value !== 'string' || value.length > 600) reject('invalid_public_duty', 'Public duty must be text of at most 600 characters');
  return value.trim();
}

function envSlotsOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) {
    reject('invalid_arguments', 'env_slots must be an array of valid environment variable names');
  }
  return [...new Set(value)];
}

export function directoryEntry(bot) {
  const role = bot.built_in_role?.id;
  const duty = defaultPublicDuty(bot);
  return {
    kind: 'bot',
    id: bot.id,
    name: bot.name,
    public_duty: duty,
    enabled: bot.enabled,
    ...(role ? { role_id: role } : {}),
    ...(bot.bundled_id ? { bundled_id: bot.bundled_id } : {}),
    ...(bot.model_provider ? { model_provider: bot.model_provider } : {}),
  };
}

export class BotManager {
  constructor({ store, dataRoot, releaseRoot, models, canUseModel }) {
    Object.assign(this, { store, dataRoot, releaseRoot, models, canUseModel });
  }

  list() { return this.store.list(botRecords); }

  get(id) {
    const record = this.store.get(botRecords, id);
    if (!record) reject('bot_not_found', 'Bot not found', 404);
    return record;
  }

  directory(id) {
    return botRootDir(this.dataRoot, id);
  }

  canConfigure(actor, bot) {
    return actor.kind === 'user' || actor.id === bot.id || sameIdentity(actor, bot.owner);
  }

  eggBot(bots = this.list()) {
    const matches = bots.filter(bot => !bot.archivedAt && bot.built_in_role?.id === eggbotRole);
    return matches.find(bot => bot.id === 'bot-default-eggbot-local') ?? matches[0] ?? null;
  }

  findByBundledId(bundledId) {
    return this.list().find(bot => !bot.archivedAt && bot.bundled_id === bundledId) || null;
  }

  bundledCatalog() {
    const installed = this.list().filter(bot => !bot.archivedAt);
    return listBundledBots(this.releaseRoot).map(pkg => {
      const active = installed.find(bot => bot.bundled_id === pkg.id || (pkg.id === 'eggbot' && bot.id === 'bot-default-eggbot-local'));
      return {
        id: pkg.id,
        name: pkg.name,
        role_id: pkg.role_id,
        public_duty: pkg.public_duty,
        model_provider: pkg.model_provider,
        env_slots: pkg.env_slots,
        skills: pkg.skills,
        scripts: pkg.scripts,
        installed: Boolean(active),
        bot_id: active?.id || null,
      };
    });
  }

  summonLead(bots = this.list()) {
    const direct = this.store.get(botRecords, botMaintenanceLeadId);
    if (direct && !direct.archivedAt) return direct;
    return bots.find(bot => !bot.archivedAt && bot.id === botMaintenanceLeadId) || null;
  }

  ensureSummonLead() {
    const existing = this.store.get(botRecords, botMaintenanceLeadId);
    if (existing && !existing.archivedAt) {
      if (existing.home_room_id || existing.auto_name_pending) {
        const cleaned = {
          ...existing,
          home_room_id: undefined,
          auto_name_pending: undefined,
          revision: (existing.revision ?? 1) + 1,
        };
        delete cleaned.home_room_id;
        delete cleaned.auto_name_pending;
        const saved = this.store.save(botRecords, cleaned);
        syncBotMetaFiles(this.dataRoot, saved);
        return saved;
      }
      return existing;
    }
    return this.saveNew({
      id: botMaintenanceLeadId,
      name: 'Summon',
      instructions: '说话利落自然、有主见、重本质，讨厌走过场套话和低效冗余设计；善于站在宿主视角算清真实体验与维护账，对干活 AI 的半成品严格把关。',
      public_duty: '全平台常驻主控搭档，跨群承接需求、把关方案与统筹交付',
      model: { mode: 'follow_default' },
      owner: user,
      built_in_role: { id: groupLeadRole },
    });
  }

  syncFolderMeta(bot) {
    if (bot) syncBotMetaFiles(this.dataRoot, bot);
  }

  ensureDefaults() {
    const existing = this.list();
    const model = { mode: 'follow_default' };
    const resolved = this.models.resolveForBot(model, 'conversation');
    let changed = false;

    const ensureDefaultModelGrant = bot => {
      if (!bot || !resolved || bot.model?.mode !== 'follow_default') return;
      const access = this.store.get('platform-access', bot.id);
      if (!access?.model_ids?.includes(resolved.connection_id)) {
        this.store.save('platform-access', {
          id: bot.id,
          revision: (access?.revision ?? 0) + 1,
          model_ids: [...new Set([...(access?.model_ids ?? []), resolved.connection_id])],
          workspace_ids: access?.workspace_ids ?? [],
        });
      }
    };

    const hadSummon = Boolean(this.summonLead(existing));
    const summon = this.ensureSummonLead();
    if (!hadSummon) changed = true;
    ensureDefaultModelGrant(summon);

    const eggId = 'bot-default-eggbot-local';
    let egg = this.eggBot(existing) ?? this.store.get(botRecords, eggId);
    if (!egg) {
      changed = true;
      const pkg = installBundledBotFiles(this.releaseRoot, this.dataRoot, 'eggbot', eggId);
      egg = this.saveNew({
        id: eggId,
        name: pkg.name || 'EggBot',
        instructions: pkg.instructions || '',
        public_duty: pkg.public_duty || '',
        bundled_id: 'eggbot',
        env_slots: pkg.env_slots || [],
        model,
        owner: user,
        built_in_role: { id: eggbotRole },
      });
    } else {
      ensureDefaultModelGrant(egg);
    }
    return { bots: [summon, egg], changed };
  }

  roleOf(id, context, bot) {
    if (context.actor.kind !== 'user' && id === eggbotRole && bot?.built_in_role?.id !== eggbotRole) {
      reject('configuration_forbidden', 'Only the host can assign the EggBot role', 403);
    }
    return id == null ? id : { id };
  }

  view(bot, actor, { details = true } = {}) {
    const diskMeta = readBotFolderMeta(this.dataRoot, bot.id);
    const liveBot = diskMeta ? {
      ...bot,
      name: typeof diskMeta.name === 'string' && diskMeta.name.trim() ? diskMeta.name.trim() : bot.name,
      public_duty: typeof diskMeta.public_duty === 'string' ? diskMeta.public_duty : bot.public_duty,
      env_slots: Array.isArray(diskMeta.env_slots) ? diskMeta.env_slots : bot.env_slots,
    } : bot;
    const base = {
      ...directoryEntry(liveBot),
      avatar: liveBot.avatar ? normalizePaperAvatar(liveBot.avatar) : defaultPaperAvatar(liveBot.id),
      env_slots: Array.isArray(liveBot.env_slots) ? liveBot.env_slots : [],
      archived_at: liveBot.archivedAt || null,
      created_at: liveBot.createdAt,
      updated_at: liveBot.updatedAt,
    };
    if (!details || !this.canConfigure(actor, liveBot)) return base;
    const target = { kind: 'bot', id: liveBot.id };
    const binding_source = liveBot.model?.mode || (liveBot.model?.connection_id ? 'custom' : 'unconfigured');
    const isDefault = isProtectedSystemBot(liveBot.id);
    const instructions = readBotInstructions(this.dataRoot, liveBot);
    const folder_files = listBotFolderFiles(this.dataRoot, liveBot.id);
    return {
      ...base,
      instructions,
      folder_files,
      model: liveBot.model,
      binding_source,
      effective_models: this.models.resolveAllForBot(liveBot),
      owner: liveBot.owner || user,
      revision: liveBot.revision,
      control: liveBot.control,
      private_space: target,
      deletable: !isDefault,
      archivable: !isDefault,
    };
  }

  modelConnectionIds(model) {
    if (!model) return [];
    const resolved = Object.values(this.models.resolveAllForBot(model)).map(item => item?.connection_id).filter(Boolean);
    const direct = [model.connection_id, ...Object.values(model.purposes || {}).map(item => item?.connection_id)].filter(Boolean);
    return [...new Set([...direct, ...resolved])];
  }

  saveNew(value) {
    const { id, model } = value;
    const record = this.store.save(botRecords, {
      ...value,
      env_slots: Array.isArray(value.env_slots) ? value.env_slots : [],
      revision: 1,
      enabled: true,
      archivedAt: null,
      control: activeControl(),
    });
    ensureBotFolder(this.dataRoot, record);
    const modelIds = this.modelConnectionIds(model);
    if (modelIds.length) this.store.save('platform-access', { id, model_ids: modelIds, workspace_ids: [] });
    return record;
  }

  selectModelBinding(rawModel) {
    return this.models.selectBinding(rawModel);
  }

  activateBundled(bundledId, context = { actor: user }, beforeSave = () => {}) {
    const existing = this.findByBundledId(bundledId);
    if (existing) return { bot: existing, created: false };
    const targetId = bundledId === 'eggbot' ? 'bot-default-eggbot-local' : `bot-bundled-${bundledId}`;
    const bot = this.store.transaction(() => {
      beforeSave();
      const saved = this.store.get(botRecords, targetId);
      if (saved && !saved.archivedAt) return saved;
      const pkg = installBundledBotFiles(this.releaseRoot, this.dataRoot, bundledId, targetId);
      let model = { mode: 'follow_default' };
      const neededIds = this.modelConnectionIds(model);
      if (neededIds.some(connId => !this.canUseModel(context.actor, connId))) {
        const creator = context.actor.kind === 'bot' ? this.store.get(botRecords, context.actor.id) : null;
        if (creator?.model) model = creator.model;
      }
      return this.saveNew({
        id: targetId,
        name: pkg.name,
        instructions: pkg.instructions || '',
        public_duty: pkg.public_duty || '',
        bundled_id: pkg.id,
        model_provider: pkg.model_provider || null,
        env_slots: pkg.env_slots || [],
        model,
        owner: context.actor,
        ...(pkg.role_id && pkg.role_id !== 'default' ? { built_in_role: { id: pkg.role_id } } : {}),
      });
    });
    return { bot, created: true };
  }

  create(id, args, context, beforeSave) {
    const { actor } = context;
    const name = cleanName(args.name);
    const instructions = instructionsOf(args.instructions ?? '');
    const env_slots = envSlotsOf(args.env_slots);
    return this.store.transaction(() => {
      beforeSave();
      const saved = this.store.get(botRecords, id);
      if (saved) return saved;
      const role = this.roleOf(args.role_id, context);
      let model = this.selectModelBinding(args.model);
      const neededIds = this.modelConnectionIds(model);
      if (neededIds.some(connId => !this.canUseModel(actor, connId))) {
        if (args.model !== undefined) reject('connection_forbidden', 'Model connection is not available to this caller', 403);
        const creator = actor.kind === 'bot' ? this.store.get(botRecords, actor.id) : null;
        const inherited = creator?.model && this.modelConnectionIds(creator.model);
        if (inherited?.length && inherited.every(connId => this.canUseModel(actor, connId))) {
          model = creator.model;
        } else {
          reject('connection_forbidden', 'Default model connection is not available to this caller', 403);
        }
      }
      return this.saveNew({
        id,
        name,
        instructions,
        env_slots,
        model,
        owner: actor,
        public_duty: publicDuty(args.public_duty ?? ''),
        ...(role ? { built_in_role: role } : {}),
      });
    });
  }

  configure(args, context, callId) {
    const { actor } = context;
    const id = idOf(args.bot, 'bot');
    const before = this.get(id);
    if (!this.canConfigure(actor, before)) {
      reject('configuration_forbidden', 'Bot configuration is not available to this caller', 403);
    }
    const selfEdit = actor.kind !== 'user' && actor.id === before.id;
    if (selfEdit) {
      if (args.role_id !== undefined && args.role_id !== (before.built_in_role?.id ?? null))
        reject('configuration_forbidden', 'A Bot cannot change its own built-in role', 403);
      if (args.enabled === false)
        reject('configuration_forbidden', 'A Bot cannot pause itself', 403);
    }
    assertRevision(before.revision, args.revision);
    const changes = {};
    if (args.name !== undefined) {
      changes.name = cleanName(args.name);
    }
    if (args.instructions !== undefined) changes.instructions = instructionsOf(args.instructions);
    if (args.public_duty !== undefined) changes.public_duty = publicDuty(args.public_duty);
    if (args.env_slots !== undefined) changes.env_slots = envSlotsOf(args.env_slots);
    const role = this.roleOf(args.role_id, context, before);
    if (role !== undefined && role?.id !== before.built_in_role?.id) changes.built_in_role = role;
    if (args.model !== undefined) {
      const model = this.selectModelBinding(args.model);
      const target = { kind: 'bot', id };
      const neededIds = this.modelConnectionIds(model);
      if (actor.kind !== 'user' && neededIds.some(connId => !this.canUseModel(actor, connId) || !this.canUseModel(target, connId))) {
        reject('connection_forbidden', 'Model connection is outside the Bot’s authorized range', 403);
      }
      if (actor.kind === 'user' && neededIds.length) {
        const access = this.store.get('platform-access', id) || {};
        const merged = [...new Set([...(access.model_ids || []), ...neededIds])];
        if (merged.length !== (access.model_ids || []).length) {
          this.store.save('platform-access', { id, revision: (access.revision ?? 0) + 1, model_ids: merged, workspace_ids: access.workspace_ids || [] });
        }
      }
      changes.model = model;
      if (before.default_model_pending) changes.default_model_pending = false;
    }
    if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
      reject('invalid_control', 'Invalid Bot control operation');
    }
    if (args.enabled === false && before.enabled) {
      changes.enabled = false;
      changes.control = { ...before.control, state: 'paused', control_version: before.control.control_version + 1, stop_id: callId, requested_by: actor, stop_status: 'pending' };
    }
    if (args.enabled === true && !before.enabled) {
      if (before.archivedAt) reject('bot_archived', 'Restore the archived Bot before enabling it', 409);
      if (!canResume(actor, before.control, before.owner || user))
        reject('restore_forbidden', 'Only the host or pausing principal can re-enable this Bot', 403);
      changes.enabled = true;
      changes.control = { state: 'active', control_version: before.control.control_version + 1, stop_id: null, requested_by: null, stop_status: null };
    }
    const bot = Object.keys(changes).length ? this.store.save(botRecords, { id, ...changes, revision: before.revision + 1 }) : before;
    syncBotMetaFiles(this.dataRoot, bot);
    return bot;
  }

  archive(id, revision, actor, callId) {
    const before = this.get(id);
    if (actor.kind !== 'user' && !sameIdentity(actor, before.owner))
      reject('configuration_forbidden', 'Bot archive requires the host or owner', 403);
    if (isProtectedSystemBot(before.id))
      reject('bot_protected', 'Default system Bots cannot be archived', 403);
    if (revision !== undefined) assertRevision(before.revision, revision);
    if (before.archivedAt) return before;
    return this.store.save(botRecords, {
      id,
      archivedAt: new Date().toISOString(),
      enabled: false,
      revision: before.revision + 1,
      control: { ...before.control, state: 'paused', control_version: before.control.control_version + 1, stop_id: callId || null, requested_by: actor, stop_status: 'pending' },
    });
  }

  restore(id, revision, actor) {
    const before = this.get(id);
    if (actor.kind !== 'user' && !sameIdentity(actor, before.owner))
      reject('configuration_forbidden', 'Bot restore requires the host or owner', 403);
    if (revision !== undefined) assertRevision(before.revision, revision);
    if (!before.archivedAt) return before;
    return this.store.save(botRecords, {
      id,
      archivedAt: null,
      enabled: true,
      revision: before.revision + 1,
      control: { state: 'active', control_version: before.control.control_version + 1, stop_id: null, requested_by: null, stop_status: null },
    });
  }

  assertRemovable(id, revision, actor) {
    if (actor.kind !== 'user') reject('configuration_forbidden', 'Only the host can delete a Bot', 403);
    const before = this.get(id);
    if (isProtectedSystemBot(before.id))
      reject('bot_protected', 'Default system Bots cannot be deleted', 403);
    if (revision !== undefined) assertRevision(before.revision, revision);
    return before;
  }

  remove(id, revision, actor) {
    const before = this.assertRemovable(id, revision, actor);
    this.store.transaction(() => {
      this.store.save(deletedBotRecords, { id: before.id, name: before.name, deletedAt: new Date().toISOString() });
      this.store.remove(botRecords, before.id);
      this.store.remove('platform-access', before.id);
    });
    return { id: before.id, name: before.name, deleted: true };
  }

  deletedName(id) {
    return this.store.get(deletedBotRecords, id)?.name || null;
  }

  settleStop(id, stopId, status) {
    const bot = this.store.get(botRecords, id);
    if (!bot || bot.control.stop_id !== stopId || bot.control.state !== 'paused') return bot;
    return this.store.save(botRecords, { id, control: { ...bot.control, stop_status: status } });
  }
}
