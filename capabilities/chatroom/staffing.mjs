import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM_DUTY_TOOLS } from '../bot-management/service.mjs';
import { fail, now, pick, required, safeId } from '../shared/validation.mjs';

export const staffingPolicyVersion = 2;
const assessments = 'team-staffing-assessments', sources = 'team-staffing-sources', staffState = 'team-staffing';
const handling = new Set(['member', 'current-work', 'independent-work', 'project-knowledge', 'defer', 'close']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const operationKey = (plan, row) => JSON.stringify([plan.roomId, plan.actor, row.operationId]);
const roomRef = message => ({ type: 'room-message', roomId: message.roomId, messageId: message.id, actor: message.senderId });
const unique = values => [...new Set(values)];
const mergeRefs = (left, right, key) => [...new Map([...left, ...right].map(item => [item[key], item])).values()];
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
const similar = (left, right, minimum) => {
  const a = norm(left), b = norm(right);
  return a && b && (a === b || Math.min(a.length, b.length) >= minimum && (a.includes(b) || b.includes(a)));
};
const identity = (subject, boundary, review) => JSON.stringify([norm(subject), norm(boundary), review]);
const sourceKey = job => JSON.stringify([job.roomId, job.teamStaffing.scope, unique(job.teamStaffing.changeKeys).sort()]);
const ids = (value, name, limit = 16) => {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item || item.length > 128))
    fail(name + ' must contain up to ' + limit + ' exact IDs');
  return unique(value);
};
const fields = {
  name: 100, subject: 250, boundary: 550, outcome: 420, acceptance: 420,
  participation: 420, retainedContext: 550, benefit: 550, workAlternativeLoss: 550, ownerFit: 550,
};
const formatProfile = row => ({
  ...pick(row, ['name', 'subject', 'boundary', 'outcome', 'acceptance', 'participation', 'retainedContext', 'independentReview']),
  aliases: row.aliases,
});

export const staffingProject = room => room?.kind === 'group' && room.status === 'active' &&
  room.projectMode !== 'chat' && ['idle', 'active'].includes(room.team?.state);
export const staffingScope = room => [room.goal, room.team.requirements, room.team.state];
export const activeDuties = (room, botId) => (room.team?.duties || []).filter(duty =>
  (!duty.state || duty.state === 'active') && room.members.includes(duty.botId) && (!botId || duty.botId === botId));
export const staffingArtifacts = message => (message.attachments || []).flatMap(({ id, name, origin }) =>
  origin?.type === 'work-output' && origin.roomId === message.roomId && origin.botId === message.senderId &&
  origin.workId === message.workId && origin.publicationId === id && origin.operationId ?
    [{ id, name, messageId: message.id, workId: message.workId, botId: message.senderId, operationId: origin.operationId }] : []);

/** Keep user scope, recent real results and earlier published deliverables in view. */
export function staffingSnapshot(chatroom, room) {
  const messages = chatroom.messages(room.id).flatMap(message => {
    const signal = chatroom.staffingEvidence(message);
    return signal ? [{ message, signal }] : [];
  });
  const selected = new Set();
  for (const { message } of messages.filter(({ signal }) => signal.kind === 'user-update').slice(-5)) selected.add(message.id);
  const reports = messages.filter(({ signal }) => signal.kind === 'work-result');
  const delivered = new Set();
  for (const { message } of [...reports].reverse()) {
    if (!message.attachments?.length || delivered.has(message.workId)) continue;
    selected.add(message.id);
    delivered.add(message.workId);
    if (delivered.size === 5) break;
  }
  for (const { message } of reports.slice(-3)) selected.add(message.id);
  const parents = messages.filter(({ message }) => selected.has(message.id) && message.replyTo)
    .map(({ message }) => message.replyTo);
  for (const id of parents.slice(-3)) selected.add(id);
  return messages.filter(({ message }) => selected.has(message.id)).map(({ signal }) => signal);
}

export class Staffing {
  constructor(team) { this.team = team; this.running = new Map(); }
  get chatroom() { return this.team.chatroom; }
  get store() { return this.team.store; }
  get manager() { return this.team.manager; }
  get(id) { return id && this.store.get(assessments, id); }
  forDelivery(job) {
    if (job?.teamStaffing?.policyVersion !== staffingPolicyVersion) return null;
    return this.get(this.store.get(sources, sourceKey(job))?.assessmentId);
  }
  latest(roomId) {
    const plan = this.get(this.store.get(staffState, roomId)?.lastAssessmentId);
    return plan?.policyVersion === staffingPolicyVersion ? plan : null;
  }

  upgrade() {
    const version = this.store.get('chatroom-schema', 'staffing');
    if (version?.version === staffingPolicyVersion) return;
    this.store.transaction(() => {
      for (const room of this.store.list('rooms').filter(item => item.team)) {
        const duties = (room.team.duties || []).map(({ staffingArea, ...duty }) => ({
          ...duty, dutyKey: duty.dutyKey || 'duty.' + randomUUID(),
          state: room.team.state === 'completed' || !room.members.includes(duty.botId) ? 'closed' : duty.state || 'active',
        }));
        if (duties.length) this.store.save('rooms', { id: room.id, team: { ...room.team, duties } });
        const state = this.store.get(staffState, room.id);
        const old = this.get(state?.activeAssessmentId);
        if (old && old.policyVersion !== staffingPolicyVersion) {
          this.store.save(assessments, { id: old.id, status: 'superseded', finishedAt: now() });
          this.store.save(staffState, { id: room.id, activeAssessmentId: null });
        }
      }
      for (const job of this.store.list('deliveries')) if (job.teamStaffing &&
          job.teamStaffing.policyVersion !== staffingPolicyVersion && !terminal.has(job.status)) {
        this.store.save('deliveries', { id: job.id, status: 'cancelled', finishedAt: now(),
          error: { code: 'STAFFING_POLICY_CHANGED', message: 'A current project assessment replaces this obsolete delivery.' } });
      }
      for (const operation of this.store.list('team-operations')) if (operation.staffingDeliveryId && operation.status === 'pending' &&
          this.store.get('deliveries', operation.staffingDeliveryId)?.teamStaffing?.policyVersion !== staffingPolicyVersion) {
        this.store.save('team-operations', { id: operation.id, status: 'blocked',
          error: 'Obsolete staffing operation; existing Bots, duties and actual receipts are retained.' });
      }
      this.store.save('chatroom-schema', { id: 'staffing', version: staffingPolicyVersion });
    });
  }

  view(plan) {
    return { assessmentId: plan.id, status: plan.status, assessedRevision: plan.assessedRevision,
      ...pick(plan, ['domain', 'phase', 'deliveryChain', 'reason', 'sourceMessageId', 'finishedAt']),
      noChange: plan.status === 'completed' && !plan.candidates.some(row => ['assigned', 'closed'].includes(row.state)),
      candidates: plan.candidates.map(row => pick(row, [...Object.keys(fields), 'handling', 'dutyKey', 'state', 'botId',
        'operationId', 'sourceRefs', 'workIds', 'artifacts', 'receipt', 'error'])) };
  }

  candidate(raw, room, job) {
    if (!raw || !handling.has(raw.handling)) fail('Choose how to handle each proposed responsibility');
    const existing = raw.dutyKey && (room.team.duties || []).find(duty => duty.dutyKey === raw.dutyKey);
    if (raw.dutyKey && !existing) fail('Use an existing dutyKey exactly as returned by chatroom_team_read');
    if (raw.handling === 'close' && !existing) fail('Choose an existing duty to close');
    const cited = ids(raw.sourceMessageIds, 'sourceMessageIds');
    if (!cited.length) fail('Cite an original source for each candidate');
    const messages = cited.map(id => this.store.get('messages', id));
    const signals = job.teamStaffing.evidence.filter(signal => cited.includes(signal.messageId));
    if (messages.some((message, index) => message?.roomId !== room.id ||
        !this.chatroom.staffingEvidence(message) && !signals.some(signal => signal.messageId === cited[index])))
      fail('Staffing needs original same-room user messages or authenticated work evidence', 403);
    const results = messages.filter(message => this.chatroom.staffingEvidence(message)?.kind === 'work-result');
    const artifacts = results.flatMap(staffingArtifacts);
    const workIds = unique([...results.map(message => message.workId), ...signals.map(signal => signal.workId).filter(Boolean)]);
    const common = { handling: raw.handling, sourceRefs: messages.map(roomRef), workIds, artifacts,
      sourceAt: messages.map(message => message.createdAt).sort().at(-1) };
    if (raw.handling === 'close') {
      if (!cited.some(id => job.teamStaffing.evidence.some(signal => signal.messageId === id &&
          job.teamStaffing.changeKeys.includes(signal.key) && ['user-update', 'work-result', 'work-acceptance'].includes(signal.kind))))
        fail('Closing a duty requires current user or work evidence that its phase ended');
      return { ...common, name: existing.dutyProfile?.name || existing.responsibility.slice(0, 100),
        dutyKey: existing.dutyKey, benefit: required(raw.benefit, 'reason for closing', 550),
        state: 'pending', operationId: 'staffing:' + randomUUID() };
    }
    const details = Object.fromEntries(Object.entries(fields).map(([key, limit]) => [key, required(raw[key], key, limit)]));
    const independentReview = raw.independentReview === undefined ?
      Boolean(existing?.dutyProfile?.independentReview) : raw.independentReview === true;
    if (existing?.dutyProfile && Boolean(existing.dutyProfile.independentReview) !== independentReview)
      fail('Keep an existing review boundary; give a genuinely independent responsibility its own duty');
    if (!norm(details.subject) || !norm(details.boundary)) fail('Name a real responsibility object and its boundary');
    const roleId = raw.roleId ? safeId(raw.roleId) : 'default';
    if (raw.roleId && !existsSync(join(this.manager.releaseRoot, 'roles', roleId, 'role.json'))) fail('Select an installed role or omit roleId');
    const separateFromDutyKeys = ids(raw.separateFromDutyKeys ?? [], 'separateFromDutyKeys');
    if (separateFromDutyKeys.some(key => !room.team.duties.some(duty => duty.dutyKey === key)))
      fail('Use actual duty keys for related but separate responsibilities');
    const candidateBotIds = ids(raw.candidateBotIds ?? [], 'candidateBotIds');
    if (candidateBotIds.some(id => !this.manager.store.get('bots', id))) fail('Use actual Bot IDs from the team or Bot list');
    const makerBotIds = unique([...results.map(message => [message.senderId, message.workId]),
      ...signals.filter(item => item.kind === 'work-dispatch').map(signal => [signal.ownerBotId, signal.workId])]
      .filter(([botId, workId]) => botId && !room.team.duties.some(duty => duty.botId === botId &&
        duty.dutyProfile?.independentReview && duty.workIds?.includes(workId))).map(([botId]) => botId));
    return { ...common, ...details, independentReview, roleId, separateFromDutyKeys,
      aliases: [identity(details.subject, details.boundary, independentReview)],
      candidateBotIds,
      requiredTools: ids(raw.requiredTools ?? [], 'requiredTools', 32),
      makerBotIds,
      ...(existing ? { dutyKey: existing.dutyKey } : {}),
      state: raw.handling === 'member' ? 'pending' : 'recorded' };
  }

  match(row, existing) {
    if (row.dutyKey && row.dutyKey === existing.dutyKey) return true;
    if (!row.aliases) return false;
    const profile = existing.dutyProfile || existing;
    if (profile.aliases?.some(alias => row.aliases.includes(alias))) return true;
    // The assessment can explicitly identify a real adjacent responsibility.
    // Never collapse production and its independent review into one owner.
    return !row.separateFromDutyKeys.includes(existing.dutyKey) && row.independentReview === profile.independentReview &&
      similar(row.subject, profile.subject, 4) && similar(row.boundary, profile.boundary, 6) &&
      row.sourceRefs.some(ref => existing.sourceRefs?.some(prior => prior.messageId === ref.messageId));
  }

  assess(input, actor, source) {
    const room = this.team.room(input.roomId, actor);
    const deliveryId = source?.input?.metadata?.deliveryId;
    const job = deliveryId && this.store.get('deliveries', deliveryId);
    if (source?.metadata?.teamStaffing !== true || source.roomId !== room.id || actor !== room.team.eggBotId ||
        !staffingProject(room) || job?.roomId !== room.id || job.botId !== actor ||
        job.teamStaffing?.policyVersion !== staffingPolicyVersion)
      fail('An assessment requires this project’s current EggBot staffing delivery', 403);
    const operationId = required(input.operationId, 'operationId', 128);
    if (input.sourceMessageId !== job.messageId) fail('Use this staffing delivery’s triggerMessageId as the assessment source');
    const previous = this.forDelivery(job);
    if (previous) return this.view(previous);
    if (terminal.has(job.status)) fail('The staffing delivery already ended', 409);
    if (input.expectedRevision !== room.team.revision) fail('Team changed; read its current revision', 409);
    if (JSON.stringify(staffingScope(room)) !== JSON.stringify(job.teamStaffing.scope))
      fail('Project scope changed; the new evidence will be assessed separately', 409);
    const state = this.store.get(staffState, room.id);
    if (state?.latestUserMessageId && state.latestUserMessageId !== job.teamStaffing.latestUserMessageId)
      fail('A newer user message has arrived; assess the new material before changing the team', 409);
    if (!Array.isArray(input.candidates)) fail('Submit zero or more concrete candidates');
    const candidates = [];
    for (const item of input.candidates) {
      const row = this.candidate(item, room, job);
      const registered = (room.team.duties || []).filter(duty => this.match(row, duty));
      if (registered.length > 1) fail('Responsibility overlaps multiple saved duties; choose its exact boundary and saved dutyKey');
      if (registered[0]) {
        if (row.dutyKey && row.dutyKey !== registered[0].dutyKey) fail('Candidate conflicts with an existing responsibility');
        row.dutyKey = registered[0].dutyKey;
      }
      const duplicate = candidates.find(prior => this.match(row, prior));
      if (duplicate) {
        if (duplicate.handling !== row.handling || row.dutyKey && duplicate.dutyKey && row.dutyKey !== duplicate.dutyKey)
          fail('Use one decision for equivalent candidates');
        duplicate.dutyKey ||= row.dutyKey;
        duplicate.sourceRefs = mergeRefs(duplicate.sourceRefs, row.sourceRefs, 'messageId');
        duplicate.workIds = unique([...duplicate.workIds, ...row.workIds]);
        duplicate.artifacts = mergeRefs(duplicate.artifacts, row.artifacts, 'id');
        if (row.sourceAt > duplicate.sourceAt) duplicate.sourceAt = row.sourceAt;
        for (const key of ['aliases', 'candidateBotIds', 'requiredTools', 'makerBotIds', 'separateFromDutyKeys'])
          if (row[key]) duplicate[key] = unique([...(duplicate[key] || []), ...row[key]]);
      } else candidates.push(row);
    }
    for (const row of candidates.filter(row => row.handling === 'member')) {
      row.dutyKey ||= 'duty.' + randomUUID();
      row.operationId = 'staffing:' + randomUUID();
    }
    const scope = {
      domain: required(input.domain, 'domain', 180), phase: required(input.phase, 'phase', 220),
      deliveryChain: required(input.deliveryChain, 'deliveryChain', 1400), reason: required(input.reason, 'reason', 900),
    };
    const key = sourceKey(job);
    const plan = this.store.transaction(() => {
      const replay = this.get(this.store.get(sources, key)?.assessmentId);
      if (replay) return replay;
      const state = this.store.get(staffState, room.id);
      if (this.get(state?.activeAssessmentId)?.status === 'applying') fail('The current assessment is still applying', 409);
      const applying = candidates.some(row => row.state === 'pending');
      const saved = this.store.save(assessments, { id: deliveryId, actor, roomId: room.id, operationId, candidates, ...scope,
        sourceMessageId: job.messageId, policyVersion: staffingPolicyVersion, assessedRevision: room.team.revision,
        scope: job.teamStaffing.scope, latestUserMessageId: job.teamStaffing.latestUserMessageId,
        status: applying ? 'applying' : 'completed', ...(applying ? {} : { finishedAt: now() }) });
      this.store.save(sources, { id: key, assessmentId: saved.id });
      this.store.save(staffState, { id: room.id, lastAssessmentId: saved.id, activeAssessmentId: applying ? saved.id : null });
      return saved;
    });
    return this.view(plan);
  }

  async available(botId, row, room, { firstRun = false } = {}) {
    const bot = this.manager.store.get('bots', botId);
    if (!bot || botId === room.team.eggBotId || bot.status !== 'active' ||
        bot.archivedAt || bot.maintenanceFor || bot.lifecycle?.state === 'dormant' ||
        bot.lifecycle?.kind === 'temporary' && bot.lifecycle.originRoomId && bot.lifecycle.originRoomId !== room.id ||
        !['chatroom_read', 'chatroom_team_read', ...row.requiredTools].every(name => bot.allowedTools?.includes(name))) return false;
    if (row.independentReview && (botId === room.team.leadBotId || row.makerBotIds.includes(botId))) return false;
    if (activeDuties(room, botId).some(duty => duty.dutyKey !== row.dutyKey && duty.dutyProfile &&
        (similar(duty.dutyProfile.subject, row.subject, 4) || row.separateFromDutyKeys.includes(duty.dutyKey)) &&
        Boolean(duty.dutyProfile.independentReview) !== row.independentReview)) return false;
    return firstRun && bot.firstRunPending === true ||
      bot.runIntent === 'running' && (await this.manager.identity(botId))?.state === 'ready';
  }

  async choose(room, row) {
    const registered = room.team.duties.find(duty => duty.dutyKey === row.dutyKey);
    if (row.handling === 'close') return registered?.state === 'closed' ?
      { state: 'covered', botId: registered.botId } : { action: 'close-duty', botId: registered?.botId };
    const create = (botId) => ({ action: 'create', roleId: row.roleId, name: row.name, ...(botId ? { botId } : {}),
      prompt: '你在此项目担任「' + row.name + '」，关注' + row.subject + '。请按本群最新登记职责和真实来源参与。任何制作或外部操作仍以当前用户授权为准。' });
    if (registered) {
      if (registered.state === 'closed' && registered.closedAt && !(row.sourceAt > registered.closedAt))
        return { state: 'covered', botId: registered.botId };
      if (await this.available(registered.botId, row, room, { firstRun: true })) {
        if (!room.members.includes(registered.botId)) return { action: 'invite', botId: registered.botId };
        if (registered.state !== 'active' || this.manager.get(registered.botId).firstRunPending)
          return { action: 'assign', botId: registered.botId };
        return { state: 'covered', botId: registered.botId, registered };
      }
      const bot = this.manager.store.get('bots', registered.botId);
      if (registered.state === 'provisioning' && row.requiredTools.every(name => TEAM_DUTY_TOOLS.includes(name)) &&
          (!bot || bot.lifecycle?.originDutyKey === row.dutyKey && bot.status === 'active' &&
            (bot.runIntent === 'running' || !existsSync(join(this.manager.directory(bot.id), 'config.json')))))
        return create(registered.botId);
      return { state: 'blocked', botId: registered.botId, error: 'The saved owner cannot cover this duty now. The responsibility and Bot are retained for explicit follow-up.' };
    }
    const ranked = [...row.candidateBotIds.filter(id => room.members.includes(id)), ...row.candidateBotIds.filter(id => !room.members.includes(id))];
    for (const botId of ranked) if (await this.available(botId, row, room, { firstRun: true }))
      return { action: room.members.includes(botId) ? 'assign' : 'invite', botId };
    const missing = row.requiredTools.filter(name => !TEAM_DUTY_TOOLS.includes(name));
    if (missing.length) return { state: 'blocked', error: 'No proposed owner has the required tools. Staffing cannot grant: ' + missing.join(', ') };
    return create();
  }

  dutyEvidence(previous, row) {
    const profile = row.aliases ? formatProfile(row) : previous?.dutyProfile;
    const dutyProfile = profile && {
      ...profile, ...(previous?.dutyProfile ? pick(previous.dutyProfile, ['name', 'subject', 'boundary', 'independentReview']) : {}),
      aliases: unique([...(previous?.dutyProfile?.aliases || []), ...(profile.aliases || [])]),
    };
    return {
      ...(dutyProfile ? { dutyProfile } : {}),
      sourceRefs: mergeRefs(previous?.sourceRefs || (previous?.source ? [previous.source] : []), row.sourceRefs, 'messageId'),
      workIds: unique([...(previous?.workIds || []), ...row.workIds]),
      artifacts: mergeRefs(previous?.artifacts || [], row.artifacts, 'id'),
    };
  }

  saveRow(plan, original, update) {
    const current = this.get(plan.id);
    if (current?.status !== 'applying') return;
    const candidates = current.candidates.map(row => row.operationId === original.operationId ? { ...row, ...update } : row);
    const pending = candidates.some(row => row.state === 'pending');
    this.store.transaction(() => {
      this.store.save(assessments, { id: plan.id, candidates,
        status: pending ? 'applying' : candidates.some(row => row.state === 'blocked') ? 'blocked' : 'completed',
        ...(pending ? {} : { finishedAt: now() }) });
      if (!pending) this.store.save(staffState, { id: plan.roomId, activeAssessmentId: null });
    });
  }

  schedule(room) {
    if (this.running.has(room.id)) return true;
    const state = this.store.get(staffState, room.id), plan = this.get(state?.activeAssessmentId);
    if (plan?.status !== 'applying' || plan.policyVersion !== staffingPolicyVersion) return false;
    const coordinator = this.manager.get(plan.actor);
    if (staffingProject(room) && (coordinator.status !== 'active' || coordinator.runIntent === 'stopped')) return true;
    if (!plan.candidates.some(row => row.state === 'pending' && (!row.retryAt || row.retryAt <= Date.now()))) return true;
    const run = this.chatroom.staffingMutation(async () => {
      const current = this.get(plan.id);
      if (current?.status !== 'applying') return;
      const row = current.candidates.find(item => item.state === 'pending' && (!item.retryAt || item.retryAt <= Date.now()));
      if (row) await this.advance(this.team.room(room.id, 'controller'), current, row);
    }).catch(error => this.chatroom.emit('team-review-error', { roomId: room.id, error: error.message }))
      .finally(() => this.running.delete(room.id));
    this.running.set(room.id, run);
    return true;
  }

  async drain() { await Promise.allSettled(this.running.values()); }

  async advance(room, plan, row) {
    const key = operationKey(plan, row), operation = this.store.get('team-operations', key);
    let input = row.input;
    try {
      if (!operation?.result && (!staffingProject(room) || room.team.eggBotId !== plan.actor ||
          JSON.stringify(staffingScope(room)) !== JSON.stringify(plan.scope) ||
          (this.store.get(staffState, room.id)?.latestUserMessageId || null) !== (plan.latestUserMessageId || null)))
        fail('Project scope or status changed. A current assessment is needed before applying this responsibility.', 409);
      if (!input) {
        const { registered, ...candidate } = await this.choose(room, row);
        if (candidate.state) {
          if (registered) {
            const evidence = this.dutyEvidence(registered, row);
            if (Object.keys(evidence).some(field => JSON.stringify(registered[field]) !== JSON.stringify(evidence[field])))
              this.team.change(room, { team: { duties: room.team.duties.map(item =>
                item.dutyKey === row.dutyKey ? { ...item, ...evidence } : item) } }, room.team.revision);
          }
          this.saveRow(plan, row, candidate);
          return;
        }
        input = { ...candidate, roomId: room.id, expectedRevision: room.team.revision, dutyKey: row.dutyKey,
          operationId: row.operationId, sourceMessageId: row.sourceRefs[0].messageId,
          reason: row.benefit, ...(row.handling === 'member' ? { responsibility: row.name + '：' + row.subject + '；' + row.boundary } : {}) };
        this.saveRow(plan, row, { input });
      }
      const source = { roomId: plan.roomId, metadata: { teamStaffing: true },
        input: { metadata: { deliveryId: plan.id } } };
      const receipt = operation?.result || await this.team.manage(input, plan.actor, source, {
        assessmentId: plan.id, scope: plan.scope, row,
      });
      const duty = receipt.room?.team?.duties?.find(item => item.dutyKey === row.dutyKey && item.operationId === row.operationId);
      if (!duty || !receipt.eventMessageId || row.handling === 'member' && !receipt.messageId)
        fail('Staffing action has no confirmed team receipt', 409);
      this.saveRow(plan, row, { state: row.handling === 'close' ? 'closed' : 'assigned', botId: duty.botId, error: null,
        receipt: pick(receipt, ['operationId', 'messageId', 'eventMessageId']) });
    } catch (error) {
      const saved = this.store.get('team-operations', key);
      const current = this.chatroom.need('rooms', room.id);
      const changedBeforeWrite = !saved && input && staffingProject(current) &&
        JSON.stringify(staffingScope(current)) === JSON.stringify(plan.scope) && input.expectedRevision !== current.team.revision;
      const attempts = (row.attempts || 0) + 1;
      const retry = attempts < 4 && (changedBeforeWrite || !error.status || error.status >= 500 || error.status === 429);
      const message = String(error.message || error).slice(0, 900);
      if (!retry && saved?.status === 'pending') this.store.save('team-operations', { id: key, status: 'blocked', error: message });
      this.saveRow(plan, row, { state: retry ? 'pending' : 'blocked', attempts,
        input: changedBeforeWrite ? null : input, retryAt: retry ? Date.now() + 5000 * attempts : null,
        firstFailure: row.firstFailure || { at: now(), message }, error: message });
    }
  }
}
