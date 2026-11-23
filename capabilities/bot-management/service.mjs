import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogMaintainerRole, defaultBotRoles, roleInstructions, toolOnboardingRole } from '../../roles/index.mjs';
import { defaultPaperAvatar, normalizePaperAvatar } from '../shared/avatar-style.mjs';
import { assertRevision, idOf, reject, sameIdentity, sameRef, user } from '../platform/contract.mjs';

export const botRecords = 'platform-bots';
export const deletedBotRecords = 'deleted-bots';

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

export function directoryEntry(bot) {
  const role = bot.built_in_role?.id;
  const duty = bot.public_duty || (Object.hasOwn(roleInstructions, role) ? roleInstructions[role].split('。')[0] : '');
  return { kind: 'bot', id: bot.id, name: bot.name, public_duty: duty, enabled: bot.enabled, ...(role ? { role_id: role } : {}) };
}

export class BotManager {
  constructor({ store, dataRoot, models, canUseModel, maintenanceConnection, bindMaintenance }) {
    Object.assign(this, { store, dataRoot, models, canUseModel, maintenanceConnection, bindMaintenance });
  }

  list() { return this.store.list(botRecords); }

  get(id) {
    const record = this.store.get(botRecords, id);
    if (!record) reject('bot_not_found', 'Bot not found', 404);
    return record;
  }

  directory(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) reject('invalid_identity', 'Invalid Bot ID');
    return join(this.dataRoot, 'bots', id);
  }

  canConfigure(actor, bot) {
    return actor.kind === 'user' || actor.id === bot.id || sameIdentity(actor, bot.owner);
  }

  defaultBot(role, bots = this.list()) {
    const matches = bots.filter(bot => !bot.archivedAt && bot.built_in_role?.id === role);
    return matches.find(bot => bot.id === `bot-default-${role}-local`) ?? matches[0];
  }

  onboardingBot() {
    return this.defaultBot(toolOnboardingRole);
  }

  ensureDefaults() {
    const existing = this.list();
    const model = { mode: 'follow_default' };
    const resolved = this.models.resolveForBot(model, 'conversation');
    let changed = false;
    const bots = Object.entries(defaultBotRoles).map(([role, name]) => {
      const id = `bot-default-${role}-local`;
      const bot = this.defaultBot(role, existing) ?? this.store.get(botRecords, id);
      if (!bot) {
        changed = true;
        return this.saveNew({ id, name, instructions: '', model, owner: user, built_in_role: { id: role } });
      }
      if (resolved && bot.model?.mode === 'follow_default') {
        const access = this.store.get('platform-access', bot.id);
        if (!access?.model_ids?.includes(resolved.connection_id)) {
          this.store.save('platform-access', { id: bot.id, revision: (access?.revision ?? 0) + 1,
            model_ids: [...new Set([...(access?.model_ids ?? []), resolved.connection_id])],
            workspace_ids: access?.workspace_ids ?? [] });
        }
      }
      return bot;
    });
    return { bots, changed };
  }

  maintainer(connection) {
    const bot = connection?.maintainer_bot_id && this.store.get(botRecords, connection.maintainer_bot_id);
    return bot && !bot.archivedAt ? bot : null;
  }

  roleOf(id, context, bot) {
    if (context.actor.kind !== 'user') {
      if (id === toolOnboardingRole || (id !== undefined && bot?.built_in_role?.id === toolOnboardingRole)) {
        reject('configuration_forbidden', 'The host selects the tool onboarding Bot', 403);
      }
      if (id === 'eggbot' && bot?.built_in_role?.id !== 'eggbot') {
        reject('configuration_forbidden', 'Only the host can assign the EggBot role', 403);
      }
    }
    if (id === toolOnboardingRole && bot?.built_in_role?.id !== toolOnboardingRole) {
      const current = this.onboardingBot();
      if (current && current.id !== bot?.id)
        reject('onboarding_bot_exists', 'A tool onboarding Bot is already assigned', 409, { bot: current.id });
    }
    return id == null ? id : { id };
  }

  assignment(args, context, role, reuse = false) {
    if (args.role_connection_id === undefined) return null;
    if (role?.id !== catalogMaintainerRole) reject('invalid_bot_role', 'Select the maintenance duty to bind this connection');
    return this.maintenanceConnection(args.role_connection_id, context, args.connection_revision, reuse);
  }

  view(bot, actor, { details = true } = {}) {
    const base = { ...directoryEntry(bot), avatar: bot.avatar ? normalizePaperAvatar(bot.avatar) : defaultPaperAvatar(bot.id),
      archived_at: bot.archivedAt || null, created_at: bot.createdAt, updated_at: bot.updatedAt };
    if (!details || !this.canConfigure(actor, bot)) return base;
    const target = { kind: 'bot', id: bot.id };
    const binding_source = bot.model?.mode || (bot.model?.connection_id ? 'custom' : 'unconfigured');
    const isDefault = Object.hasOwn(defaultBotRoles, bot.built_in_role?.id) && bot.id === `bot-default-${bot.built_in_role.id}-local`;
    return { ...base, instructions: bot.instructions, model: bot.model, binding_source, effective_models: this.models.resolveAllForBot(bot),
      owner: bot.owner || user, revision: bot.revision, control: bot.control, material_index_ref: bot.material_index_ref || null,
      private_space: target, deletable: !isDefault, archivable: !isDefault };
  }

  modelConnectionIds(model) {
    if (!model) return [];
    const resolved = Object.values(this.models.resolveAllForBot(model)).map(item => item?.connection_id).filter(Boolean);
    const direct = [model.connection_id, ...Object.values(model.purposes || {}).map(item => item?.connection_id)].filter(Boolean);
    return [...new Set([...direct, ...resolved])];
  }

  saveNew(value) {
    const { id, model } = value;
    mkdirSync(this.directory(id), { recursive: true });
    const record = this.store.save(botRecords, { ...value, revision: 1, enabled: true, archivedAt: null,
      control: activeControl(), material_index_ref: null });
    const modelIds = this.modelConnectionIds(model);
    if (modelIds.length) this.store.save('platform-access', { id, model_ids: modelIds, workspace_ids: [] });
    return record;
  }

  create(id, args, context, beforeSave) {
    const { actor } = context;
    const name = cleanName(args.name), instructions = instructionsOf(args.instructions);
    return this.store.transaction(() => {
      beforeSave();
      const saved = this.store.get(botRecords, id);
      if (saved) return saved;
      const role = this.roleOf(args.role_id, context);
      const connection = this.assignment(args, context, role, true);
      const assigned = this.maintainer(connection);
      if (assigned) return assigned;
      let model = this.models.selectBinding(args.model);
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
      const record = this.saveNew({ id, name, instructions, model, owner: actor, public_duty: publicDuty(args.public_duty ?? ''),
        ...(role ? { built_in_role: role } : {}) });
      if (connection) this.bindMaintenance(connection, record);
      return record;
    });
  }

  configure(args, context, callId, validateIndex) {
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
      if (args.instructions !== undefined && args.instructions !== before.instructions)
        reject('configuration_forbidden', 'A Bot cannot overwrite its own instructions', 403);
      if (args.enabled === false)
        reject('configuration_forbidden', 'A Bot cannot pause itself', 403);
    }
    assertRevision(before.revision, args.revision);
    const changes = {};
    if (args.name !== undefined) changes.name = cleanName(args.name);
    if (args.instructions !== undefined) changes.instructions = instructionsOf(args.instructions);
    if (args.public_duty !== undefined) changes.public_duty = publicDuty(args.public_duty);
    const role = this.roleOf(args.role_id, context, before);
    if (role !== undefined && role?.id !== before.built_in_role?.id) changes.built_in_role = role;
    const connection = this.assignment(args, context, role === undefined ? before.built_in_role : role);
    const maintainer = this.maintainer(connection);
    if (maintainer && maintainer.id !== id)
      reject('connection_maintainer_exists', 'This connection already has a maintenance Bot', 409,
        { maintainer: { kind: 'bot', id: maintainer.id } });
    if (args.model !== undefined) {
      const model = this.models.selectBinding(args.model);
      const target = { kind: 'bot', id };
      const neededIds = this.modelConnectionIds(model);
      if (actor.kind !== 'user' && neededIds.some(connId => !this.canUseModel(actor, connId) || !this.canUseModel(target, connId))) {
        reject('connection_forbidden', 'Model connection is outside the Bot’s authorized range', 403);
      }
      if (actor.kind === 'user' && neededIds.length) {
        const access = this.store.get('platform-access', id) || {};
        const merged = [...new Set([...(access.model_ids || []), ...neededIds])];
        if (merged.length !== (access.model_ids || []).length) {
          this.store.save('platform-access', { id, revision: (access.revision ?? 0) + 1,
            model_ids: merged, workspace_ids: access.workspace_ids || [] });
        }
      }
      changes.model = model;
      if (before.default_model_pending) changes.default_model_pending = false;
    }
    if (args.material_index_ref !== undefined) {
      if (args.material_index_ref !== null) validateIndex(args.material_index_ref, id);
      changes.material_index_ref = args.material_index_ref;
    }
    if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
      reject('invalid_control', 'Invalid Bot control operation');
    }
    if (args.enabled === false && before.enabled) {
      changes.enabled = false;
      changes.control = { ...before.control, state: 'paused', control_version: before.control.control_version + 1,
        stop_id: callId, requested_by: actor, stop_status: 'pending' };
    }
    if (args.enabled === true && !before.enabled) {
      if (before.archivedAt) reject('bot_archived', 'Restore the archived Bot before enabling it', 409);
      if (!canResume(actor, before.control, before.owner || user))
        reject('restore_forbidden', 'Only the host or pausing principal can re-enable this Bot', 403);
      changes.enabled = true;
      changes.control = { state: 'active', control_version: before.control.control_version + 1,
        stop_id: null, requested_by: null, stop_status: null };
    }
    const bot = Object.keys(changes).length ? this.store.save(botRecords, { id, ...changes, revision: before.revision + 1 }) : before;
    if (connection) this.bindMaintenance(connection, bot);
    return bot;
  }

  archive(id, revision, actor, callId) {
    const before = this.get(id);
    if (actor.kind !== 'user' && !sameIdentity(actor, before.owner))
      reject('configuration_forbidden', 'Bot archive requires the host or owner', 403);
    if (before.connection_initializer || (Object.hasOwn(defaultBotRoles, before.built_in_role?.id) && before.id === `bot-default-${before.built_in_role.id}-local`))
      reject('bot_protected', 'Default system Bots cannot be archived', 403);
    if (revision !== undefined) assertRevision(before.revision, revision);
    if (before.archivedAt) return before;
    return this.store.save(botRecords, {
      id, archivedAt: new Date().toISOString(), enabled: false, revision: before.revision + 1,
      control: { ...before.control, state: 'paused', control_version: before.control.control_version + 1,
        stop_id: callId || null, requested_by: actor, stop_status: 'pending' },
    });
  }

  restore(id, revision, actor) {
    const before = this.get(id);
    if (actor.kind !== 'user' && !sameIdentity(actor, before.owner))
      reject('configuration_forbidden', 'Bot restore requires the host or owner', 403);
    if (revision !== undefined) assertRevision(before.revision, revision);
    if (!before.archivedAt) return before;
    return this.store.save(botRecords, {
      id, archivedAt: null, enabled: true, revision: before.revision + 1,
      control: { state: 'active', control_version: before.control.control_version + 1,
        stop_id: null, requested_by: null, stop_status: null },
    });
  }

  assertRemovable(id, revision, actor) {
    if (actor.kind !== 'user') reject('configuration_forbidden', 'Only the host can delete a Bot', 403);
    const before = this.get(id);
    if (before.connection_initializer || (Object.hasOwn(defaultBotRoles, before.built_in_role?.id) && before.id === `bot-default-${before.built_in_role.id}-local`))
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
