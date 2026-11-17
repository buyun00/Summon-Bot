import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogMaintainerRole, defaultBotRoles, toolOnboardingRole } from '../../roles/index.mjs';
import { defaultPaperAvatar, normalizePaperAvatar } from '../shared/avatar-style.mjs';
import { assertRevision, idOf, reject, sameIdentity, sameRef, user } from '../platform/contract.mjs';

export const botRecords = 'platform-bots';

export function activeControl() {
  return { state: 'active', control_version: 1, stop_id: null, requested_by: null, stop_status: null };
}

export function resumeReference(target, control) {
  if (control.state !== 'paused') return null;
  return { target, stop_id: control.stop_id, control_version: control.control_version };
}

export function canResume(actor, control, owner) {
  return sameIdentity(actor, control.requested_by) || (control.requested_by?.kind !== 'user' &&
    (actor.kind === 'user' || sameIdentity(actor, owner)));
}

export function assertResume(actor, target, control, reference, owner) {
  if (!canResume(actor, control, owner)) reject('restore_forbidden', 'This caller does not have permission to resume the stopped execution', 403);
  if (control.state !== 'paused' || !sameRef(target, reference?.target) || reference.stop_id !== control.stop_id ||
      reference.control_version !== control.control_version) {
    reject('resume_conflict', 'The stop reference has changed', 409, { control_version: control.control_version });
  }
  if (control.stop_status !== 'stopped') {
    reject('stop_unconfirmed', 'The affected execution has not confirmed that it stopped', 409, { stop_status: control.stop_status });
  }
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

export class BotManager {
  constructor({ store, dataRoot, resources, models, canUseModel, maintenanceConnection, bindMaintenance }) {
    Object.assign(this, { store, dataRoot, resources, models, canUseModel, maintenanceConnection, bindMaintenance });
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
    return !bot.connection_initializer && (actor.kind === 'user' || actor.id === bot.id || sameIdentity(actor, bot.owner));
  }

  onboardingBot(workspaceProfileId) {
    return this.list().find(bot => !bot.archivedAt && !bot.connection_initializer &&
      (bot.workspaceProfileId ?? null) === workspaceProfileId && bot.built_in_role?.id === toolOnboardingRole);
  }

  ensureDefaults(workspaceProfileId) {
    const existing = this.list().filter(bot => !bot.archivedAt && !bot.connection_initializer &&
      (bot.workspaceProfileId ?? null) === workspaceProfileId);
    const model = this.models.selectBinding(undefined, workspaceProfileId);
    let changed = false;
    const bots = Object.entries(defaultBotRoles).map(([role, name]) => {
      const id = `bot-default-${role}-${workspaceProfileId ?? 'local'}`;
      const bot = existing.find(item => item.built_in_role?.id === role) ?? this.store.get(botRecords, id);
      if (!bot) {
        changed = true;
        return this.saveNew({ id, name, instructions: '', model, owner: user, workspaceProfileId,
          built_in_role: { id: role }, ...(!model ? { default_model_pending: true } : {}) });
      }
      if (!model || !bot.default_model_pending || bot.archivedAt || bot.built_in_role?.id !== role) return bot;
      const access = this.store.get('platform-access', bot.id);
      this.store.save('platform-access', { id: bot.id, revision: (access?.revision ?? 0) + 1,
        model_ids: [...new Set([...(access?.model_ids ?? []), model.connection_id])] });
      changed = true;
      return this.store.save(botRecords, { id: bot.id, model, revision: bot.revision + 1, default_model_pending: false });
    });
    return { bots, changed };
  }

  maintainer(connection) {
    const bot = connection?.maintainer_bot_id && this.store.get(botRecords, connection.maintainer_bot_id);
    return bot && !bot.archivedAt && !bot.connection_initializer &&
      (bot.workspaceProfileId ?? null) === (connection.workspaceProfileId ?? null) ? bot : null;
  }

  roleOf(id, context, bot) {
    if ((id === toolOnboardingRole || id !== undefined && bot?.built_in_role?.id === toolOnboardingRole) && context.actor.kind !== 'user') {
      reject('configuration_forbidden', 'The host selects the workspace tool onboarding Bot', 403);
    }
    if (id === toolOnboardingRole) {
      const current = this.onboardingBot(context.workspaceProfileId);
      if (current && current.id !== bot?.id)
        reject('onboarding_bot_exists', 'This workspace already has a tool onboarding Bot', 409, { bot: current.id });
    }
    return id == null ? id : { id };
  }

  assignment(args, context, role, reuse = false) {
    if (args.role_connection_id === undefined) return null;
    if (role?.id !== catalogMaintainerRole) reject('invalid_bot_role', 'Select the maintenance duty to bind this connection');
    return this.maintenanceConnection(args.role_connection_id, context, args.connection_revision, reuse);
  }

  view(bot, actor, { details = true } = {}) {
    const base = { kind: 'bot', id: bot.id, name: bot.name, avatar: bot.avatar ? normalizePaperAvatar(bot.avatar) : defaultPaperAvatar(bot.id),
      enabled: bot.enabled, created_at: bot.createdAt, updated_at: bot.updatedAt,
      ...(bot.built_in_role ? { role_id: bot.built_in_role.id } : {}) };
    if (!details || !this.canConfigure(actor, bot)) return base;
    const target = { kind: 'bot', id: bot.id };
    return { ...base, instructions: bot.instructions, model: bot.model, revision: bot.revision, control: bot.control,
      material_index_ref: bot.material_index_ref || null, private_space: target,
      resume_ref: canResume(actor, bot.control, bot.owner) ? resumeReference(target, bot.control) : null };
  }

  saveNew(value) {
    const { id, model } = value;
    mkdirSync(this.directory(id), { recursive: true });
    const record = this.store.save(botRecords, { ...value, revision: 1, enabled: true,
      control: activeControl(), material_index_ref: null });
    if (model) this.store.save('platform-access', { id, model_ids: [model.connection_id], connection_ids: [], workspace_ids: [] });
    return record;
  }

  create(id, args, context, beforeSave) {
    const { actor, workspaceProfileId } = context;
    const name = cleanName(args.name), instructions = instructionsOf(args.instructions);
    return this.store.transaction(() => {
      beforeSave();
      const saved = this.store.get(botRecords, id);
      if (saved) return saved;
      const role = this.roleOf(args.role_id, context);
      const connection = this.assignment(args, context, role, true);
      const assigned = this.maintainer(connection);
      if (assigned) return assigned;
      let model = this.models.selectBinding(args.model, workspaceProfileId);
      if (model && !this.canUseModel(actor, model.connection_id, context)) {
        if (args.model !== undefined) reject('connection_forbidden', 'Model connection is not available to this caller', 403);
        model = null;
      }
      this.resources.assertCapacity('bots', this.list().filter(bot => !bot.connection_initializer).length);
      const record = this.saveNew({ id, name, instructions, model, owner: actor, workspaceProfileId: workspaceProfileId ?? null,
        ...(role ? { built_in_role: role } : {}) });
      if (connection) this.bindMaintenance(connection, record);
      return record;
    });
  }

  configure(args, context, callId, validateIndex) {
    const { actor, workspaceProfileId } = context;
    const id = idOf(args.bot, 'bot');
    const before = this.get(id);
    if (!this.canConfigure(actor, before) || (before.workspaceProfileId ?? null) !== workspaceProfileId) {
      reject('configuration_forbidden', 'Bot configuration is not available to this caller', 403);
    }
    assertRevision(before.revision, args.revision);
    const changes = {};
    if (args.name !== undefined) changes.name = cleanName(args.name);
    if (args.instructions !== undefined) changes.instructions = instructionsOf(args.instructions);
    const role = this.roleOf(args.role_id, context, before);
    if (role !== undefined && role?.id !== before.built_in_role?.id) changes.built_in_role = role;
    const connection = this.assignment(args, context, role === undefined ? before.built_in_role : role);
    const maintainer = this.maintainer(connection);
    if (maintainer && maintainer.id !== id)
      reject('connection_maintainer_exists', 'This connection already has a maintenance Bot', 409,
        { maintainer: { kind: 'bot', id: maintainer.id } });
    if (args.model !== undefined) {
      const model = this.models.selectBinding(args.model, workspaceProfileId);
      const target = { kind: 'bot', id };
      if (model && (!this.canUseModel(actor, model.connection_id, context) || !this.canUseModel(target, model.connection_id))) {
        reject('connection_forbidden', 'Model connection is outside the Bot’s authorized range', 403);
      }
      changes.model = model;
      if (before.default_model_pending) changes.default_model_pending = false;
    }
    if (args.material_index_ref !== undefined) {
      if (args.material_index_ref !== null) validateIndex(args.material_index_ref, id);
      changes.material_index_ref = args.material_index_ref;
    }
    if (args.enabled !== undefined && (typeof args.enabled !== 'boolean' || args.enabled === before.enabled && args.resume_ref)) {
      reject('invalid_control', 'Invalid Bot control operation');
    }
    if (args.enabled === false && before.enabled) {
      changes.enabled = false;
      changes.control = { ...before.control, state: 'paused', control_version: before.control.control_version + 1,
        stop_id: callId, requested_by: actor, stop_status: 'pending' };
    }
    if (args.enabled === true && !before.enabled) {
      assertResume(actor, { kind: 'bot', id }, before.control, args.resume_ref, before.owner || user);
      changes.enabled = true;
      changes.control = { ...before.control, state: 'active', control_version: before.control.control_version + 1 };
    } else if (args.resume_ref) {
      reject('invalid_control', 'Resume requires an explicit enable operation');
    }
    const bot = Object.keys(changes).length ? this.store.save(botRecords, { id, ...changes, revision: before.revision + 1 }) : before;
    if (connection) this.bindMaintenance(connection, bot);
    return bot;
  }

  settleStop(id, stopId, status) {
    const bot = this.get(id);
    if (bot.control.stop_id !== stopId || bot.control.state !== 'paused') return bot;
    return this.store.save(botRecords, { id, control: { ...bot.control, stop_status: status } });
  }
}
