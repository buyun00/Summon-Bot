import { randomUUID } from 'node:crypto';
import { localTime } from '../../bot/src/context/fact-time.mjs';
import { EXISTING_PUBLICATION } from '../../bot/src/context/duty-actions.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM_DUTY_TOOLS } from '../bot-management/tool-access.mjs';
import { workflowReviewerId } from '../../bot/src/context/workflow-review.mjs';
import { workflowComparison } from '../../bot/src/context/workflow-comparison.mjs';
import { fail, now, pick, required, safeId } from '../shared/validation.mjs';

export const staffingPolicyVersion = 4;
const assessments = 'team-staffing-assessments', sources = 'team-staffing-sources', staffState = 'team-staffing';
const choices = 'team-staffing-choices';
const proposalPrefix = 'team-staffing-proposal:';
const projectIntents = new Set(['project', 'ordinary', 'unclear']);
const handling = new Set(['member', 'current-work', 'independent-work', 'project-knowledge', 'defer', 'close']);
const workDecisions = new Set(['retain', 'adjust', 'handoff']);
const dutyChanges = new Set(['adjust', 'handoff']);
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
  participation: 420, retainedContext: 550, ownerFit: 550, benefit: 550, alternative: 420, workAlternativeLoss: 550,
};
const requireComparison = value => {
  const comparison = workflowComparison(value);
  if (!comparison) fail('Record feasibility, fit, the specific alternative and its tradeoff');
  return comparison;
};
const formatProfile = row => ({
  ...pick(row, ['name', 'subject', 'boundary', 'outcome', 'acceptance', 'participation', 'retainedContext', 'independentReview']),
  aliases: row.aliases,
});

export const staffingProject = room => room?.kind === 'group' && room.status !== 'concluded' &&
  room.projectMode !== 'chat' && ['idle', 'active'].includes(room.team?.state);
export const staffingScope = room => [room.goal, room.team.requirements, room.projectMode || 'auto'];
const sameScope = (room, scope) => JSON.stringify(staffingScope(room)) === JSON.stringify(scope);
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
  for (const { message } of messages.filter(({ signal }) => signal.kind === 'work-progress').slice(-3)) selected.add(message.id);
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
  isChoice(messageId) { return Boolean(this.store.get(choices, messageId)); }
  proposals(room) {
    return this.chatroom.roomRows.all(assessments, room.id).map(record => JSON.parse(record.data))
      .filter(plan => plan.choiceMessageId && plan.policyVersion === staffingPolicyVersion && sameScope(room, plan.scope));
  }
  proposalHistory(room) {
    return this.proposals(room).slice(-8).map(plan => ({ messageId: plan.choiceMessageId,
      duties: plan.candidates.filter(row => row.options?.length).map(row =>
        pick(row, ['dutyKey', 'dutyChange', 'name', 'subject', 'boundary', 'state', 'choice'])) }));
  }

  upgrade() {
    const version = this.store.get('chatroom-schema', 'staffing');
    if (version?.version === staffingPolicyVersion) return;
    this.store.transaction(() => {
      for (const room of this.store.list('rooms').filter(item => item.team)) {
        if ((version?.version || 0) < 3 && room.team.duties?.length) {
          const jobs = this.chatroom.jobs(room.id).filter(job => job.routedDutyKey && job.workId && job.taskId && job.status === 'completed');
          const duties = room.team.duties.map(({ staffingArea, ...duty }) => {
            // Certify only exact deliveries to this duty's owner.
            const owned = jobs.filter(job => job.routedDutyKey === duty.dutyKey && job.botId === duty.botId &&
              duty.workIds?.includes(job.workId) && this.store.get('messages', job.messageId)?.senderId === 'user');
            const artifacts = (duty.artifacts || []).filter(artifact => owned.some(job => {
              const result = this.store.get('messages', artifact.messageId);
              return job.workId === artifact.workId && result?.senderId === job.botId && result.replyTo === job.messageId &&
                staffingArtifacts(result).some(item => item.id === artifact.id && item.operationId === artifact.operationId);
            }));
            return { ...duty, dutyKey: duty.dutyKey || 'duty.' + randomUUID(),
              state: room.team.state === 'completed' || !room.members.includes(duty.botId) ? 'closed' : duty.state || 'active',
              referenceWorkIds: unique([...(duty.referenceWorkIds || []), ...(duty.workIds || [])]),
              referenceArtifacts: mergeRefs(duty.referenceArtifacts || [], duty.artifacts || [], 'id'),
              workIds: unique(owned.map(job => job.workId)), artifacts,
              workBindings: mergeRefs(duty.workBindings || [], artifacts.map(artifact => ({ workId: artifact.workId, botId: artifact.botId,
                operationId: artifact.operationId, sourceMessageId: this.store.get('messages', artifact.messageId).replyTo })), 'operationId') };
          });
          this.store.save('rooms', { id: room.id, team: { ...room.team, duties } });
        }
        const state = this.store.get(staffState, room.id);
        const old = this.get(state?.activeAssessmentId);
        if (old && old.policyVersion !== staffingPolicyVersion) {
          this.store.save(assessments, { id: old.id, status: 'superseded', finishedAt: now() });
          this.store.save(staffState, { id: room.id, activeAssessmentId: null });
        }
        if (state && (sameScope(room, state.scope) || JSON.stringify(state.scope) === JSON.stringify([room.goal, room.team.requirements, room.team.state])))
          this.store.save(staffState, { id: room.id, scope: staffingScope(room), policyVersion: staffingPolicyVersion });
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
      ...pick(plan, ['domain', 'phase', 'deliveryChain', 'reason', 'projectIntent', 'workReviews', 'sourceMessageId', 'finishedAt',
        'analysisAsOf', 'currentPublications', 'choiceMessageId', 'comparison', 'sourceRefs']),
      noChange: plan.status === 'completed' && !plan.candidates.some(row => ['awaiting-choice', 'assigned', 'closed'].includes(row.state)),
      candidates: plan.candidates.map(row => pick(row, [...Object.keys(fields), 'handling', 'dutyKey', 'state', 'botId',
        'dutyChange', 'operationId', 'sourceRefs', 'referenceWorkIds', 'referenceArtifacts', 'receipt', 'error', 'choice'])) };
  }

  candidate(raw, room, job, offered) {
    if (!raw || !handling.has(raw.handling)) fail('Choose how to handle each proposed responsibility');
    const existing = raw.dutyKey && (room.team.duties || []).find(duty => duty.dutyKey === raw.dutyKey);
    if (raw.dutyKey && !existing && !offered.some(row => row.dutyKey === raw.dutyKey))
      fail('Use a saved or proposed dutyKey exactly as returned by chatroom_team_read');
    if (raw.handling === 'close' && !existing) fail('Choose an existing duty to close');
    const cited = ids(raw.sourceMessageIds ?? [job.messageId], 'sourceMessageIds');
    const citedMessages = cited.map(id => this.store.get('messages', id));
    if (citedMessages.some(message => message?.roomId !== room.id))
      fail('A candidate source is outside this room. Copy the full message ID from the same-room snapshot or an authorized room read.', 403);
    const signals = job.teamStaffing.evidence.filter(signal => cited.includes(signal.messageId));
    const messages = citedMessages.filter(message => this.chatroom.staffingEvidence(message) || signals.some(signal => signal.messageId === message.id));
    if (!messages.length) return { handling: 'defer', state: 'recorded',
      name: existing?.dutyProfile?.name || String(raw.name || '未确认职责').slice(0, 100),
      benefit: '没有可用于分工的真实来源；普通回复仅保留为讨论背景。',
      sourceRefs: [], referenceWorkIds: [], referenceArtifacts: [] };
    const results = messages.filter(message => ['work-result', 'work-progress'].includes(this.chatroom.staffingEvidence(message)?.kind));
    const artifacts = results.flatMap(staffingArtifacts);
    const reviewWorks = job.input?.content?.staffing?.reviewWorks || [];
    const workIds = unique([...results.map(message => message.workId), ...signals.map(signal => signal.workId).filter(Boolean),
      ...reviewWorks.filter(work => work.sourceMessageIds.some(id => cited.includes(id))).map(work => work.id)]);
    const common = { handling: raw.handling, sourceRefs: messages.map(roomRef), referenceWorkIds: workIds, referenceArtifacts: artifacts,
      sourceAt: messages.map(message => message.createdAt).sort().at(-1) };
    if (raw.handling === 'close') {
      const scopedTextOnly = signals.some(signal => signal.kind === 'room-result-acceptance' &&
        this.store.get('room-text-results', signal.resultId)?.dutyKey === existing.dutyKey &&
        this.store.get('room-text-results', signal.resultId)?.kind === 'room-handoff') &&
        !signals.some(signal => ['work-result', 'work-acceptance'].includes(signal.kind));
      if (scopedTextOnly) return { ...common, handling: 'defer', state: 'recorded', dutyKey: existing.dutyKey,
        name: existing.dutyProfile?.name || existing.responsibility.slice(0, 100),
        benefit: '本次验收只结清这条文字交付，原持续职责仍保留。' };
      if (!signals.some(signal => {
        if (!job.teamStaffing.changeKeys.includes(signal.key)) return false;
        if (['user-update', 'work-result', 'work-acceptance'].includes(signal.kind)) return true;
        const result = signal.kind === 'room-result' && this.store.get('room-text-results', signal.resultId);
        return result?.kind === 'independent-review' && result.dutyKey === existing.dutyKey && result.ownerBotId === existing.botId;
      }))
        fail('Closing a duty requires current user or work evidence that its phase ended');
      return { ...common, name: existing.dutyProfile?.name || existing.responsibility.slice(0, 100),
        dutyKey: existing.dutyKey, benefit: required(raw.benefit, 'reason for closing', 550),
        ownerFit: required(raw.ownerFit, 'ownerFit', 550), alternative: required(raw.alternative, 'alternative', 420),
        workAlternativeLoss: required(raw.workAlternativeLoss, 'workAlternativeLoss', 550),
        state: 'recorded' };
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
    const reviewPublications = signals.filter(signal => signal.kind === 'room-duty-plan').map(signal =>
      this.chatroom.dutyActions.get(signal.planId)?.dependency).filter(dependency => dependency?.condition === EXISTING_PUBLICATION);
    const dutyChange = raw.dutyChange;
    if (dutyChange && (!dutyChanges.has(dutyChange) || !existing || existing.state !== 'active' || raw.handling !== 'member'))
      fail('A scope adjustment or handoff requires an active saved member duty');
    const makerBotIds = unique([...results.map(message => [message.senderId, message.workId]),
      ...reviewPublications.map(({ publication }) => [publication.makerBotId, publication.workId]),
      ...signals.filter(item => item.kind === 'work-dispatch').map(signal => [signal.ownerBotId, signal.workId]),
      ...reviewWorks.filter(work => workIds.includes(work.id) && work.productionStage).map(work => [work.botId, work.id])]
      .filter(([botId, workId]) => botId && !room.team.duties.some(duty => duty.botId === botId &&
        duty.dutyProfile?.independentReview && duty.workIds?.includes(workId))).map(([botId]) => botId));
    return { ...common, ...details, independentReview, roleId, separateFromDutyKeys,
      aliases: [identity(details.subject, details.boundary, independentReview)],
      candidateBotIds,
      requiredTools: ids(raw.requiredTools ?? [], 'requiredTools', 32),
      makerBotIds,
      ...(raw.dutyKey ? { dutyKey: raw.dutyKey } : {}), ...(dutyChange ? { dutyChange } : {}),
      state: 'recorded' };
  }

  match(row, existing) {
    if (row.dutyKey && row.dutyKey === existing.dutyKey) return true;
    if (!row.aliases) return false;
    if (row.separateFromDutyKeys.includes(existing.dutyKey)) return false;
    const profile = existing.dutyProfile || existing;
    if (profile.aliases?.some(alias => row.aliases.includes(alias))) return true;
    // The assessment can explicitly identify a real adjacent responsibility.
    // Never collapse production and its independent review into one owner.
    return row.independentReview === profile.independentReview &&
      similar(row.subject, profile.subject, 4) && similar(row.boundary, profile.boundary, 6) &&
      row.sourceRefs.some(ref => existing.sourceRefs?.some(prior => prior.messageId === ref.messageId));
  }

  workReviews(input, job) {
    const work = new Map((job.input?.content?.staffing?.reviewWorks || []).map(item => [item.id, item]));
    if (!Array.isArray(input.workReviews)) fail('Submit workReviews for the supplied room works');
    const reviewed = new Set();
    const reviews = input.workReviews.map(row => {
      const view = work.get(row?.workId);
      if (!view || reviewed.has(row.workId) || !workDecisions.has(row.decision))
        fail('Review each supplied work once, with retain, adjust or handoff');
      reviewed.add(row.workId);
      const facts = Object.fromEntries(['requirements', 'scope', 'progress'].map(key =>
        [key, required(row[key], key, 900)]));
      const citedSourceMessageIds = ids(row.sourceMessageIds ?? [], 'work review sourceMessageIds').filter(id => {
        const message = this.store.get('messages', id);
        return message?.roomId === job.roomId && message.createdAt <= job.input.content.staffing.snapshotAt;
      });
      return { workId: view.id, ownerBotId: view.botId, decision: row.decision, ...facts, comparison: requireComparison(row.comparison),
        citedSourceMessageIds,
        sourceMessageIds: unique([...view.sourceMessageIds, ...(view.published || []).map(message => message.messageId),
          ...(view.savedAcceptance ? [view.savedAcceptance.messageId, ...view.savedAcceptance.publicationMessageIds] : []), ...job.teamStaffing.evidence
          .filter(signal => signal.workId === view.id).map(signal => signal.messageId)]) };
    });
    if (input.projectIntent === 'project' && reviewed.size !== work.size)
      fail('Compare every item in staffing.reviewWorks before deciding');
    return reviews;
  }

  assess(input, actor, source) {
    const deliveryId = source?.input?.metadata?.deliveryId;
    const job = deliveryId && this.store.get('deliveries', deliveryId);
    const room = this.team.room(input.roomId || job?.roomId, actor);
    if (source?.metadata?.teamStaffing !== true || source.roomId !== room.id || actor !== room.team.eggBotId ||
        !staffingProject(room) || job?.roomId !== room.id || job.botId !== actor ||
        job.teamStaffing?.policyVersion !== staffingPolicyVersion)
      fail('An assessment requires this project’s current EggBot staffing delivery', 403);
    const operationId = job.id;
    const previous = this.forDelivery(job);
    if (previous) return this.view(previous);
    if (terminal.has(job.status)) fail('The staffing delivery already ended', 409);
    const state = this.store.get(staffState, room.id);
    if (!sameScope(room, job.teamStaffing.scope) ||
        state?.latestUserMessageId && state.latestUserMessageId !== job.teamStaffing.latestUserMessageId)
      return this.view(this.supersede(job, room));
    if (input.expectedRevision !== undefined && input.expectedRevision !== room.team.revision)
      fail('Team changed; read its current revision', 409);
    if (!projectIntents.has(input.projectIntent)) fail('Classify the current project intent');
    const currentEvidence = job.teamStaffing.evidence.filter(signal => job.teamStaffing.changeKeys.includes(signal.key));
    if (input.projectIntent !== 'project' && currentEvidence.some(signal => signal.kind !== 'user-update'))
      fail('Current project evidence requires a project assessment');
    const comparison = requireComparison(input.comparison);
    const cited = ids(input.sourceMessageIds ?? [job.messageId], 'assessment sourceMessageIds');
    if (!cited.length) fail('Cite at least one actual message for the project comparison');
    const evidence = cited.map(id => this.store.get('messages', id));
    if (evidence.some(message => message?.roomId !== room.id)) fail('An assessment source is outside this room', 403);
    const sourceRefs = evidence.map(roomRef);
    const workReviews = this.workReviews(input, job);
    if (!Array.isArray(input.candidates) || input.candidates.length > 12) fail('Submit up to twelve concrete candidates');
    if (input.projectIntent !== 'project' && input.candidates.length) fail('Ordinary or unclear discussion has no staffing candidates');
    const proposals = this.proposals(room), offered = proposals.flatMap(plan => plan.candidates.filter(row => row.options?.length));
    const candidates = [];
    for (const item of input.candidates) {
      const row = this.candidate(item, room, job, offered);
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
        duplicate.referenceWorkIds = unique([...duplicate.referenceWorkIds, ...row.referenceWorkIds]);
        duplicate.referenceArtifacts = mergeRefs(duplicate.referenceArtifacts, row.referenceArtifacts, 'id');
        if (row.sourceAt > duplicate.sourceAt) duplicate.sourceAt = row.sourceAt;
        for (const key of ['aliases', 'candidateBotIds', 'requiredTools', 'makerBotIds', 'separateFromDutyKeys'])
          if (row[key]) duplicate[key] = unique([...(duplicate[key] || []), ...row[key]]);
      } else candidates.push(row);
    }
    for (const row of candidates) this.prepareChoice(room, row, offered);
    const asking = candidates.some(row => row.state === 'awaiting-choice');
    const firstScope = input.projectIntent === 'project' && !offered.length && !activeDuties(room).length && !workReviews.length;
    const userSources = new Set(currentEvidence.filter(signal => signal.kind === 'user-update').map(signal => signal.messageId));
    if (firstScope && userSources.size && candidates.some(row => row.state === 'awaiting-choice' &&
      !row.sourceRefs.some(ref => userSources.has(ref.messageId))))
      fail('A first staffing proposal must cite the current user’s project words');
    const scope = {
      domain: required(input.domain, 'domain', 180), phase: required(input.phase, 'phase', 220),
      deliveryChain: required(input.deliveryChain, 'deliveryChain', 1400), reason: required(input.reason, 'reason', 900),
    };
    const analysisAsOf = job.input?.content?.staffing?.snapshotAt || job.createdAt;
    const currentPublications = this.team.staffingPublications(room.id, job.teamStaffing.evidence);
    const newer = currentPublications.filter(result => result.publishedAt > analysisAsOf);
    if (newer.length) scope.reason = `以下判断基于 ${localTime(analysisAsOf)} 的快照。此后同源实际发布：${newer.map(result =>
      `${localTime(result.publishedAt)}（消息 ${result.messageId}）`).join('、')}。当前交付以这些发布回执为准。\n${scope.reason}`;
    const key = sourceKey(job);
    const plan = this.store.transaction(() => {
      const replay = this.get(this.store.get(sources, key)?.assessmentId);
      if (replay) return replay;
      const saved = this.store.save(assessments, { id: deliveryId, actor, roomId: room.id, operationId, candidates, ...scope,
        analysisAsOf, currentPublications, projectIntent: input.projectIntent, comparison, sourceRefs, workReviews,
        ...(asking ? { choiceMessageId: proposalPrefix + deliveryId } : {}),
        sourceMessageId: job.messageId, policyVersion: staffingPolicyVersion, assessedRevision: room.team.revision,
        scope: job.teamStaffing.scope, latestUserMessageId: job.teamStaffing.latestUserMessageId,
        status: 'completed', finishedAt: now() });
      this.store.save(sources, { id: key, assessmentId: saved.id });
      if (input.projectIntent === 'project') this.store.save(staffState, { id: room.id, lastAssessmentId: saved.id });
      if (input.projectIntent === 'ordinary') for (const signal of currentEvidence)
        this.team.skipOrdinarySource(room, signal.messageId);
      if (asking) this.publishChoice(room, saved);
      return saved;
    });
    return this.view(plan);
  }

  supersede(job, room) {
    return this.store.transaction(() => {
      const prior = this.forDelivery(job);
      if (prior) return prior;
      const plan = this.store.save(assessments, { id: job.id, actor: job.botId, roomId: job.roomId, operationId: job.id,
        status: 'superseded', candidates: [], sourceMessageId: job.messageId, policyVersion: staffingPolicyVersion,
        assessedRevision: room.team.revision, finishedAt: now(), reason: 'A newer source or project scope replaced this assessment.' });
      this.store.save(sources, { id: sourceKey(job), assessmentId: plan.id });
      return plan;
    });
  }

  fits(botId, row, room) {
    const bot = this.manager.store.get('bots', botId);
    if (!bot || [room.team.eggBotId, workflowReviewerId].includes(botId) || bot.status !== 'active' ||
        bot.archivedAt || bot.maintenanceFor || bot.lifecycle?.state === 'dormant' ||
        bot.lifecycle?.kind === 'temporary' && bot.lifecycle.originRoomId && bot.lifecycle.originRoomId !== room.id ||
        !['chatroom_read', 'chatroom_team_read', ...row.requiredTools].every(name => bot.allowedTools?.includes(name))) return false;
    if (row.independentReview && (botId === room.team.leadBotId || row.makerBotIds.includes(botId))) return false;
    if (activeDuties(room, botId).some(duty => duty.dutyKey !== row.dutyKey && duty.dutyProfile &&
        (similar(duty.dutyProfile.subject, row.subject, 4) || row.separateFromDutyKeys.includes(duty.dutyKey)) &&
        Boolean(duty.dutyProfile.independentReview) !== row.independentReview)) return false;
    return bot.firstRunPending === true || bot.runIntent === 'running';
  }

  async available(botId, row, room, { firstRun = false } = {}) {
    if (!this.fits(botId, row, room)) return false;
    const bot = this.manager.get(botId);
    return firstRun && bot.firstRunPending === true ||
      bot.runIntent === 'running' && (await this.manager.identity(botId))?.state === 'ready';
  }

  prepareChoice(room, row, offered) {
    if (!['member', 'close'].includes(row.handling)) return;
    const registered = room.team.duties.find(duty => duty.dutyKey === row.dutyKey);
    const prior = offered.find(item => (['awaiting-choice', 'pending', 'declined'].includes(item.state) ||
        registered?.operationId === item.operationId && ['assigned', 'closed'].includes(item.state)) &&
      item.handling === row.handling && item.dutyChange === row.dutyChange &&
      (this.match(row, item) || row.aliases && row.independentReview === item.independentReview &&
        norm(row.subject) === norm(item.subject) && norm(row.name) === norm(item.name)));
    if (prior) {
      row.dutyKey = prior.dutyKey;
      row.state = 'already-offered';
      return;
    }
    const options = [];
    if (row.handling === 'close') {
      if (registered.state === 'active') options.push({ command: '结清', action: 'close-duty', botId: registered.botId });
    } else if (row.dutyChange === 'adjust') {
      if (room.members.includes(registered.botId) && this.fits(registered.botId, row, room))
        options.push({ command: '调整', action: 'assign', botId: registered.botId });
    } else if (row.dutyChange === 'handoff') {
      const target = row.candidateBotIds.find(id => id !== registered.botId && this.fits(id, row, room));
      options.push({ command: '交接', action: 'handoff-duty', botId: target, named: true });
    } else if (registered) {
      if (registered.state === 'closed' && row.sourceAt > registered.closedAt && this.fits(registered.botId, row, room))
        options.push({ command: room.members.includes(registered.botId) ? '复用' : '邀请',
          action: room.members.includes(registered.botId) ? 'assign' : 'invite', botId: registered.botId });
      else if (registered.state === 'active' && this.fits(registered.botId, row, room)) row.state = 'covered';
    } else {
      const suitable = row.candidateBotIds.filter(id => this.fits(id, row, room));
      const member = suitable.find(id => room.members.includes(id));
      const invitee = suitable.find(id => !room.members.includes(id));
      if (row.requiredTools.every(name => TEAM_DUTY_TOOLS.includes(name))) options.push({ command: '创建', action: 'create' });
      options.push({ command: '邀请', action: 'invite', botId: invitee, named: true });
      if (member) options.push({ command: '复用', action: 'assign', botId: member, named: true });
    }
    if (!options.length) return;
    row.dutyKey ||= 'duty.' + randomUUID();
    Object.assign(row, { state: 'awaiting-choice', operationId: 'staffing:' + randomUUID(), options,
      previousOwnerId: registered?.botId || null, previousAssignmentId: registered?.operationId || null });
  }

  publishChoice(room, plan) {
    const proposed = plan.candidates.filter(row => row.options?.length);
    const sections = proposed.map((row, index) => {
      const number = index + 1;
      const options = row.options.map(({ command, botId, named }) => {
        const name = botId && this.manager.get(botId).name;
        if (named && !name) return `「${command} ${number} Bot 名称」`;
        return `「${command} ${number}」${name ? `（${name}）` : ''}`;
      });
      return `${number}. ${row.name}。 ${[row.boundary, row.benefit].filter(Boolean).join(' ')}\n${options.join('、')}`;
    });
    this.chatroom.append(room.id, { id: plan.choiceMessageId, replyTo: plan.sourceMessageId,
      eventType: 'team_staffing_proposal', purpose: 'fyi',
      content: ['我建议按这些职责分工。你希望怎么安排？', ...sections,
        '请回复这条消息，填写对应的选择。想邀请其他已有 Bot，可以回复「邀请 编号 Bot 名称」。也可以回复「暂不组队」，继续当前讨论。'].join('\n\n'),
      sourceRefs: mergeRefs([], proposed.flatMap(row => row.sourceRefs), 'messageId') }, plan.actor);
  }

  recordChoice(room, message) {
    if (!room.team || message.attachments?.length || message.toBotId && message.toBotId !== room.team.eggBotId ||
        message.replyTo && (typeof message.replyTo !== 'string' || !message.replyTo.startsWith(proposalPrefix))) return false;
    const text = message.content.normalize('NFKC').trim().replace(/[。！!]+$/, '');
    const decline = /^(暂不|暂时不|先不|暂时先不)组队$/.test(text);
    const requested = decline ? [] : text.split(/[\n;]+/).map(part =>
      /^(?:请\s*)?(创建|邀请|复用|调整|交接|结清)\s*(\d+)(?:\s+(.+))?$/.exec(part.trim()));
    if (requested.some(part => !part)) return false;
    const open = message.replyTo ? [this.get(message.replyTo.slice(proposalPrefix.length))] :
      this.proposals(room).filter(item => item.candidates.some(row => row.state === 'awaiting-choice'));
    if (open.length !== 1) return false;
    const [plan] = open;
    const proposal = plan?.choiceMessageId && this.store.get('messages', plan.choiceMessageId);
    if (plan?.roomId !== room.id || proposal?.senderId !== room.team.eggBotId) return false;
    const proposed = plan.candidates.filter(row => row.options?.length);
    const answer = (content, selected = []) => {
      this.store.save(choices, { id: message.id, roomId: room.id, assessmentId: plan.id, selected, declined: decline, answer: content });
      this.chatroom.append(room.id, { id: 'team-staffing-choice:' + message.id, replyTo: message.id,
        eventType: 'team_staffing_choice', purpose: 'fyi', content }, plan.actor);
      return true;
    };
    if (plan.policyVersion !== staffingPolicyVersion || !staffingProject(room) || !sameScope(room, plan.scope))
      return answer('这次分工建议已过期，请按当前项目范围讨论。');
    const updates = new Map();
    for (const [, command, index, name] of requested) {
      const row = proposed[Number(index) - 1];
      const option = row?.options.find(item => item.command === command);
      if (!option || updates.has(row.dutyKey) || name && !option.named) return answer('请按这条建议中的编号和选项回复。');
      const botId = name ? this.choiceBot(room, row, option, name) : option.botId;
      if (!botId && option.action !== 'create') return answer('请填写唯一可用的 Bot 名称或 ID。');
      const choice = { action: option.action, command, botId: botId || null, messageId: message.id };
      const selectable = ['awaiting-choice', 'declined'].includes(row.state);
      if (!selectable &&
          (row.choice?.action !== choice.action || row.choice?.botId !== choice.botId))
        return answer('这一项已有处理结果，请重新讨论要调整的职责。');
      if (selectable) updates.set(row.dutyKey, { ...row, state: 'pending', choice });
    }
    if (decline) for (const row of proposed.filter(row => row.state === 'awaiting-choice'))
      updates.set(row.dutyKey, { ...row, state: 'declined', choice: { action: 'decline', messageId: message.id } });
    const changed = [...updates.values()];
    if (!changed.length) return answer('这次选择已记录。');
    const candidates = plan.candidates.map(row => updates.get(row.dutyKey) || row);
    if (decline) {
      this.store.save(assessments, { id: plan.id, candidates });
      return answer('好，暂不组队，按现有安排继续讨论。');
    }
    this.store.save(assessments, { id: plan.id, status: 'applying', candidates, finishedAt: null });
    const state = this.store.get(staffState, room.id);
    this.store.save(staffState, { id: room.id, applyingAssessmentIds: unique([...(state?.applyingAssessmentIds || []), plan.id]) });
    return answer('已收到你的分工选择。', changed.map(row => ({ dutyKey: row.dutyKey, ...row.choice })));
  }

  choiceBot(room, row, option, name) {
    const requested = name.trim().toLowerCase();
    const available = this.manager.store.list('bots').filter(bot => this.fits(bot.id, row, room) &&
      (option.action === 'assign' ? room.members.includes(bot.id) : option.action !== 'invite' || !room.members.includes(bot.id)) &&
      (option.action !== 'handoff-duty' || bot.id !== row.previousOwnerId));
    const byId = available.find(bot => bot.id === requested);
    if (byId) return byId.id;
    const matches = available.filter(bot => bot.name.normalize('NFKC').toLowerCase() === requested);
    return matches.length === 1 ? matches[0].id : null;
  }

  async choose(room, row) {
    const { action, botId } = row.choice;
    const registered = room.team.duties.find(duty => duty.dutyKey === row.dutyKey);
    if ((registered?.botId || null) !== row.previousOwnerId || (registered?.operationId || null) !== row.previousAssignmentId)
      fail('职责已由其他操作变更，原选择未应用。', 409);
    if (action === 'close-duty') return { action, botId };
    if (action === 'create') return { action, roleId: row.roleId, name: row.name,
      prompt: '你在此项目担任「' + row.name + '」，关注' + row.subject + '。请按本群最新登记职责和真实来源参与。制作或外部操作以当前用户授权为准。' };
    if (!await this.available(botId, row, room, { firstRun: true })) fail('所选成员当前不可用或缺少这项职责需要的工具。', 409);
    const assigned = room.members.includes(botId);
    if (action === 'assign' && !assigned) fail('所选成员已不在本群。', 409);
    return { action: action === 'handoff-duty' ? assigned ? 'assign' : 'invite' : action === 'invite' && assigned ? 'assign' : action, botId };
  }

  dutyEvidence(previous, row) {
    const profile = row.aliases ? formatProfile(row) : previous?.dutyProfile;
    const dutyProfile = profile && {
      ...profile, ...(previous?.dutyProfile && !row.dutyChange ?
        pick(previous.dutyProfile, ['name', 'subject', 'boundary', 'independentReview']) : {}),
      aliases: unique([...(previous?.dutyProfile?.aliases || []), ...(profile.aliases || [])]),
    };
    return {
      ...(dutyProfile ? { dutyProfile } : {}),
      sourceRefs: mergeRefs(previous?.sourceRefs || (previous?.source ? [previous.source] : []), row.sourceRefs, 'messageId'),
      referenceWorkIds: unique([...(previous?.referenceWorkIds || []), ...(row.referenceWorkIds || [])]),
      referenceArtifacts: mergeRefs(previous?.referenceArtifacts || [], row.referenceArtifacts || [], 'id'),
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
      if (!pending) {
        const state = this.store.get(staffState, plan.roomId);
        this.store.save(staffState, { id: plan.roomId,
          applyingAssessmentIds: (state?.applyingAssessmentIds || []).filter(id => id !== plan.id) });
      }
      if (['blocked', 'superseded'].includes(update.state)) this.chatroom.append(plan.roomId, {
        id: 'team-staffing-outcome:' + original.operationId, replyTo: original.choice.messageId,
        eventType: 'team_staffing_choice', purpose: 'fyi',
        content: `「${original.name}」的分工选择未落实。 ${update.error}`,
      }, plan.actor);
    });
  }

  schedule(room) {
    if (this.running.has(room.id)) return true;
    const state = this.store.get(staffState, room.id);
    const plan = (state?.applyingAssessmentIds || []).map(id => this.get(id))
      .find(item => item?.status === 'applying' && item.policyVersion === staffingPolicyVersion);
    if (!plan) return false;
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
      const choice = this.store.get(choices, row.choice?.messageId);
      if (!operation?.result && (!staffingProject(room) || room.team.eggBotId !== plan.actor || !sameScope(room, plan.scope) ||
          choice?.assessmentId !== plan.id || !choice.selected.some(item => item.dutyKey === row.dutyKey &&
            item.action === row.choice.action && item.botId === row.choice.botId))) {
        this.store.transaction(() => {
          this.saveRow(plan, row, { state: 'superseded', error: '项目范围或组队选择已变更。' });
          if (operation?.status === 'pending') this.store.save('team-operations', { id: operation.id, status: 'superseded' });
        });
        return;
      }
      if (!input) {
        const candidate = await this.choose(room, row);
        input = { ...candidate, roomId: room.id, expectedRevision: room.team.revision, dutyKey: row.dutyKey,
          operationId: row.operationId, sourceMessageId: row.choice.messageId,
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
      const changedBeforeWrite = !saved && input && staffingProject(current) && sameScope(current, plan.scope) &&
        input.expectedRevision !== current.team.revision;
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
