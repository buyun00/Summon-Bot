import { idOf, identity, keyOf, reject } from './contract.mjs';
import { wakeupRecords } from './delivery.mjs';
import { sessionRecords } from './executions.mjs';

export const goalRecords = 'room-goals';

const GOAL_STATUSES = new Set(['active', 'awaiting_user', 'completed', 'stopped']);
const STEP_STATUSES = new Set(['pending', 'in_progress', 'awaiting_user', 'done', 'blocked', 'skipped']);
const LIVE_SESSION_STATUSES = new Set(['opening', 'running', 'waiting', 'awaiting_input', 'needs_input', 'stopping']);
const GOAL_IDLE_DEBOUNCE_MS = 12_000;
const DEFAULT_MAX_CONTINUATIONS = 3;

function cleanText(value, maxLen = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeOwner(owner, roomMembers) {
  if (owner == null || owner === '') return null;
  const resolved = typeof owner === 'string'
    ? (owner.trim() === 'user' ? 'user' : owner.trim())
    : owner?.kind === 'user'
      ? 'user'
      : owner?.kind === 'bot' && typeof owner.id === 'string'
        ? owner.id.trim()
        : null;
  if (!resolved) return null;
  if (Array.isArray(roomMembers) && roomMembers.length && !roomMembers.includes(resolved)) {
    return null;
  }
  return resolved;
}

function normalizeStep(raw, index, roomMembers, nowIso, priorStep = null) {
  const id = cleanText(raw?.id || priorStep?.id || `s${index + 1}`, 48) || `s${index + 1}`;
  const title = cleanText(raw?.title ?? priorStep?.title ?? '', 140);
  if (!title) reject('invalid_goal', `Step ${id} requires a non-empty title`);
  const status = raw?.status ?? priorStep?.status ?? 'pending';
  if (!STEP_STATUSES.has(status)) reject('invalid_goal', `Invalid step status: ${status}`);
  const owner = raw?.owner !== undefined
    ? normalizeOwner(raw.owner, roomMembers)
    : (priorStep?.owner ?? null);
  const note = raw?.note !== undefined
    ? cleanText(raw.note, 260)
    : (priorStep?.note ?? '');
  const changed = !priorStep || priorStep.status !== status || priorStep.title !== title || priorStep.owner !== owner || priorStep.note !== note;
  return {
    id,
    title,
    owner,
    status,
    ...(note ? { note } : {}),
    updated_at: changed ? nowIso : (priorStep?.updated_at || nowIso),
  };
}

function deriveStatus(explicitStatus, steps) {
  if (explicitStatus === 'stopped') return 'stopped';
  const hasActionable = steps.some(s => s.status === 'in_progress' || s.status === 'pending');
  const hasWaiting = steps.some(s => s.status === 'awaiting_user' || s.status === 'blocked');
  const allClosed = steps.length > 0 && steps.every(s => s.status === 'done' || s.status === 'skipped');
  if (explicitStatus === 'completed') return 'completed';
  if (allClosed) return 'completed';
  if (explicitStatus === 'awaiting_user') return 'awaiting_user';
  if (hasWaiting && !steps.some(s => s.status === 'in_progress')) return 'awaiting_user';
  if (explicitStatus === 'active') {
    if (!hasActionable) return hasWaiting ? 'awaiting_user' : 'completed';
    return 'active';
  }
  if (hasActionable) return 'active';
  return hasWaiting ? 'awaiting_user' : 'completed';
}

function currentActionableStep(steps = []) {
  return steps.find(s => s.status === 'in_progress')
    || steps.find(s => s.status === 'pending')
    || steps.find(s => s.status === 'awaiting_user')
    || steps.find(s => s.status === 'blocked')
    || null;
}

export class GoalManager {
  constructor(platform) {
    this.platform = platform;
  }

  get(roomId) {
    if (!roomId) return null;
    return this.platform.store.get(goalRecords, roomId) || null;
  }

  view(roomId) {
    const goal = this.get(roomId);
    if (!goal) return null;
    const steps = Array.isArray(goal.steps) ? goal.steps : [];
    const total = steps.length;
    const done = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const active = currentActionableStep(steps);
    const activeIndex = active ? steps.findIndex(s => s.id === active.id) + 1 : total;
    return {
      ...goal,
      kind: 'goal',
      progress: {
        done,
        total,
        current_step_id: active?.id || null,
        current_step_index: active ? activeIndex : total,
        current_step_title: active?.title || null,
        current_step_owner: active?.owner || goal.owner_bot_id || null,
        current_step_status: active?.status || goal.status,
      },
    };
  }

  update(args, context) {
    const roomId = idOf(args.room, 'room');
    const room = this.platform.store.get('rooms', roomId);
    if (!room) reject('room_not_found', 'Room not found', 404);
    if (room.archivedAt) reject('room_archived', 'Cannot update goals in an archived Room', 409);
    if (context.actor.kind === 'bot' && !room.members.includes(context.actor.id)) {
      reject('room_forbidden', 'Room membership is required to update the Room goal', 403);
    }

    if (args.clear === true) {
      const existing = this.get(roomId);
      if (existing) {
        this.platform.store.delete(goalRecords, roomId);
        this.platform.emit('room', { id: roomId });
        this.platform.emit('execution', { room_id: roomId });
      }
      return { room_id: roomId, cleared: true, goal: null };
    }

    const nowIso = new Date().toISOString();
    const existing = this.get(roomId);
    const isReplacing = Boolean(args.title && Array.isArray(args.steps) && args.steps.length);
    const base = isReplacing ? null : existing;

    if (!base && (!args.title || !Array.isArray(args.steps) || !args.steps.length)) {
      reject('invalid_goal', 'Creating a Room goal requires both title and a non-empty steps array');
    }

    const title = args.title !== undefined ? cleanText(args.title, 100) : (base?.title || '');
    if (!title) reject('invalid_goal', 'Goal title cannot be empty');

    const done_criteria = args.done_criteria !== undefined
      ? cleanText(args.done_criteria, 400)
      : (base?.done_criteria || '');

    const owner_bot_id = args.owner !== undefined
      ? (normalizeOwner(args.owner, room.members) || room.lead_bot_id || (context.actor.kind === 'bot' ? context.actor.id : null))
      : (base?.owner_bot_id || room.lead_bot_id || (context.actor.kind === 'bot' ? context.actor.id : null));

    const origin_message_id = args.origin_message_id !== undefined
      ? (args.origin_message_id ? idOf(args.origin_message_id, 'event') : null)
      : (base?.origin_message_id ?? null);

    let steps;
    if (Array.isArray(args.steps)) {
      if (!args.steps.length || args.steps.length > 10) {
        reject('invalid_goal', 'Goal steps must contain 1 to 10 items');
      }
      const priorById = new Map((base?.steps || []).map(s => [s.id, s]));
      const seenIds = new Set();
      steps = args.steps.map((raw, idx) => {
        const step = normalizeStep(raw, idx, room.members, nowIso, raw?.id ? priorById.get(raw.id) : null);
        if (seenIds.has(step.id)) step.id = `${step.id}-${idx + 1}`;
        seenIds.add(step.id);
        return step;
      });
    } else {
      steps = (base?.steps || []).map(s => ({ ...s }));
    }

    if (Array.isArray(args.step_updates) && args.step_updates.length) {
      const byId = new Map(steps.map((s, idx) => [s.id, idx]));
      for (const patch of args.step_updates) {
        const idx = byId.get(patch.id);
        if (idx === undefined) reject('invalid_goal', `Step not found: ${patch.id}`, 404);
        steps[idx] = normalizeStep(patch, idx, room.members, nowIso, steps[idx]);
      }
    }

    if (args.status !== undefined && !GOAL_STATUSES.has(args.status)) {
      reject('invalid_goal', `Invalid goal status: ${args.status}`);
    }

    const status = deriveStatus(args.status, steps);
    const substantiveChange = !existing || isReplacing
      || existing.status !== status
      || existing.title !== title
      || existing.owner_bot_id !== owner_bot_id
      || (existing.steps?.length || 0) !== steps.length
      || steps.some((step, idx) => {
        const prev = existing.steps?.[idx];
        return !prev || prev.id !== step.id || prev.status !== step.status || prev.owner !== step.owner || prev.title !== step.title;
      });
    // Only reset continuation_count when the goal makes substantive structural/status progress;
    // pure note edits cannot reset the anti-spin circuit breaker.
    const saved = this.platform.store.save(goalRecords, {
      id: roomId,
      room_id: roomId,
      title,
      ...(done_criteria ? { done_criteria } : { done_criteria: '' }),
      status,
      owner_bot_id,
      origin_message_id,
      steps,
      continuation_count: substantiveChange ? 0 : (existing?.continuation_count ?? 0),
      max_continuations: base?.max_continuations ?? DEFAULT_MAX_CONTINUATIONS,
      stalled: substantiveChange ? false : (existing?.stalled ?? false),
      stall_reason: substantiveChange ? null : (existing?.stall_reason ?? null),
      last_progress_at: substantiveChange ? nowIso : (existing?.last_progress_at || nowIso),
      last_continued_at: substantiveChange ? null : (existing?.last_continued_at ?? null),
      revision: (existing?.revision ?? 0) + 1,
      created_at: base?.created_at || nowIso,
      updated_at: nowIso,
      updated_by: context.actor,
    });

    this.platform.emit('room', { id: roomId });
    this.platform.emit('execution', { room_id: roomId });
    return this.view(saved.room_id);
  }

  onUserMessage(roomId) {
    const goal = this.get(roomId);
    if (!goal) return;
    if (goal.status === 'completed' || goal.status === 'stopped') {
      this.platform.store.delete(goalRecords, roomId);
      this.platform.emit('room', { id: roomId });
      this.platform.emit('execution', { room_id: roomId });
      return;
    }
    const nowIso = new Date().toISOString();
    const steps = (goal.steps || []).map(step => (
      step.status === 'awaiting_user'
        ? { ...step, status: 'in_progress', updated_at: nowIso }
        : step
    ));
    const nextStatus = goal.status === 'awaiting_user' ? deriveStatus('active', steps) : goal.status;
    this.platform.store.save(goalRecords, {
      id: roomId,
      status: nextStatus,
      steps,
      continuation_count: 0,
      stalled: false,
      stall_reason: null,
      last_progress_at: nowIso,
      updated_at: nowIso,
    });
    this.platform.emit('room', { id: roomId });
  }

  onAwaitingUser(roomId) {
    const goal = this.get(roomId);
    if (!goal || goal.status !== 'active') return;
    const nowIso = new Date().toISOString();
    const steps = (goal.steps || []).map(s => ({ ...s }));
    const active = steps.find(s => s.status === 'in_progress') || steps.find(s => s.status === 'pending');
    if (active) {
      active.status = 'awaiting_user';
      active.updated_at = nowIso;
    }
    this.platform.store.save(goalRecords, {
      id: roomId,
      status: 'awaiting_user',
      steps,
      continuation_count: 0,
      stalled: false,
      stall_reason: null,
      last_progress_at: nowIso,
      updated_at: nowIso,
    });
    this.platform.emit('room', { id: roomId });
  }

  onRoomActivity(roomId, kind = 'activity') {
    const goal = this.get(roomId);
    if (!goal || goal.status !== 'active') return;
    const nowIso = new Date().toISOString();
    const patch = {
      id: roomId,
      last_progress_at: nowIso,
    };
    if (kind === 'session') {
      patch.continuation_count = 0;
      patch.stalled = false;
      patch.stall_reason = null;
    }
    this.platform.store.save(goalRecords, patch);
  }

  stop(roomId, actor = { kind: 'user', id: 'user' }) {
    const goal = this.get(roomId);
    if (!goal || !['active', 'awaiting_user'].includes(goal.status)) return this.view(roomId);
    const nowIso = new Date().toISOString();
    this.platform.store.save(goalRecords, {
      id: roomId,
      status: 'stopped',
      stalled: false,
      stall_reason: null,
      updated_at: nowIso,
      updated_by: actor,
      revision: (goal.revision ?? 0) + 1,
    });
    this.platform.emit('room', { id: roomId });
    this.platform.emit('execution', { room_id: roomId });
    return this.view(roomId);
  }

  resume(roomId, actor = { kind: 'user', id: 'user' }) {
    const room = this.platform.store.get('rooms', roomId);
    if (!room) reject('room_not_found', 'Room not found', 404);
    const goal = this.get(roomId);
    if (!goal) reject('goal_not_found', 'No goal exists for this Room', 404);
    const nowIso = new Date().toISOString();
    const steps = (goal.steps || []).map(step => (
      ['awaiting_user', 'blocked'].includes(step.status)
        ? { ...step, status: 'in_progress', updated_at: nowIso }
        : step
    ));
    const hasActionable = steps.some(s => s.status === 'in_progress' || s.status === 'pending');
    if (!hasActionable) reject('goal_completed', 'All steps in this goal are already complete', 409);
    const saved = this.platform.store.save(goalRecords, {
      id: roomId,
      status: 'active',
      steps,
      continuation_count: 0,
      stalled: false,
      stall_reason: null,
      last_progress_at: new Date(Date.now() - GOAL_IDLE_DEBOUNCE_MS).toISOString(),
      last_continued_at: null,
      updated_at: nowIso,
      updated_by: actor,
      revision: (goal.revision ?? 0) + 1,
    });
    this.platform.emit('room', { id: roomId });
    this.platform.emit('execution', { room_id: roomId });
    this.tick();
    return this.view(saved.room_id);
  }

  remove(roomId) {
    if (this.get(roomId)) {
      this.platform.store.delete(goalRecords, roomId);
      this.platform.emit('room', { id: roomId });
      this.platform.emit('execution', { room_id: roomId });
    }
  }

  roomHasLiveSessions(roomId) {
    for (const session of this.platform.store.list(sessionRecords)) {
      if (session.authority_revoked || session.control?.state !== 'active') continue;
      if (!LIVE_SESSION_STATUSES.has(session.status)) continue;
      if (session.origin_room?.id === roomId
        || (session.source_space?.kind === 'room' && session.source_space.id === roomId)
        || (session.space?.kind === 'room' && session.space.id === roomId)) {
        return true;
      }
    }
    return false;
  }

  roomHasPendingDeliveries(roomId) {
    for (const delivery of this.platform.store.list('platform-deliveries')) {
      if (!['pending', 'received', 'unknown'].includes(delivery.status)) continue;
      const evRoom = delivery.event?.space?.kind === 'room' ? delivery.event.space.id : delivery.event?.roomId;
      if (evRoom === roomId) return true;
    }
    return false;
  }

  roomHasPendingTimeWakeup(roomId, goal, nowMs) {
    const goalCreatedMs = Date.parse(goal.created_at || 0) || 0;
    const room = this.platform.store.get('rooms', roomId);
    const members = new Set(room?.members || []);
    for (const wakeup of this.platform.store.list(wakeupRecords)) {
      if (!wakeup.enabled || wakeup.archived === true || wakeup.member_active === false) continue;
      if (wakeup.rule?.kind !== 'time') continue;
      const nextDue = Number(wakeup.next_due);
      if (!Number.isFinite(nextDue) || nextDue <= nowMs) continue;
      const scopeRoom = wakeup.rule.room || (wakeup.rule.scope?.kind === 'room' ? wakeup.rule.scope.id : null);
      if (scopeRoom && scopeRoom !== roomId) continue;
      if (!scopeRoom && !members.has(wakeup.bot_id)) continue;
      const isOneShot = !wakeup.rule.interval_ms;
      const createdMs = Date.parse(wakeup.createdAt || wakeup.created_at || 0) || 0;
      const updatedMs = Date.parse(wakeup.updatedAt || wakeup.updated_at || 0) || 0;
      const awaitingFirstRunForGoal = !wakeup.last_event_id && Math.max(createdMs, updatedMs) >= goalCreatedMs;
      if (isOneShot || awaitingFirstRunForGoal) return true;
    }
    return false;
  }

  latestRoomSessionFinishMs(roomId) {
    let latest = 0;
    for (const session of this.platform.store.list(sessionRecords)) {
      if (session.origin_room?.id !== roomId && session.space?.id !== roomId) continue;
      const ts = Date.parse(session.updated_at || session.created_at || 0) || 0;
      if (ts > latest) latest = ts;
    }
    return latest;
  }

  resolveTargetBot(room, goal, step) {
    const candidates = [step?.owner, goal.owner_bot_id, room.lead_bot_id];
    for (const id of candidates) {
      if (!id || id === 'user' || !room.members.includes(id)) continue;
      const bot = this.platform.store.get('platform-bots', id);
      if (bot && bot.enabled !== false && !bot.archivedAt) return bot;
    }
    return null;
  }

  tick() {
    if (this.platform.draining || !this.platform.runtime) return;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    for (const goal of this.platform.store.list(goalRecords)) {
      if (goal.status !== 'active' || goal.stalled) continue;
      const room = this.platform.store.get('rooms', goal.room_id);
      if (!room || room.mode !== 'group' || room.archivedAt) continue;
      if (this.platform.deliveries.roomChainState(room.id)?.paused) continue;

      const steps = Array.isArray(goal.steps) ? goal.steps : [];
      const currentStep = steps.find(s => s.status === 'in_progress') || steps.find(s => s.status === 'pending');
      if (!currentStep) {
        const nextStatus = steps.some(s => s.status === 'awaiting_user' || s.status === 'blocked') ? 'awaiting_user' : 'completed';
        this.platform.store.save(goalRecords, { id: room.id, status: nextStatus, updated_at: nowIso });
        this.platform.emit('room', { id: room.id });
        continue;
      }

      if (this.roomHasLiveSessions(room.id)) continue;
      if (this.roomHasPendingDeliveries(room.id)) continue;
      if (this.platform.runtime.roomHasActiveWork?.(room.id)) continue;
      if (this.roomHasPendingTimeWakeup(room.id, goal, nowMs)) continue;

      const latestMsg = this.platform.room.latestMessage.get(room.id);
      const latestMsgMs = latestMsg ? (Date.parse(JSON.parse(latestMsg.data).createdAt || 0) || 0) : 0;
      const lastActivityMs = Math.max(
        Date.parse(goal.last_progress_at || 0) || 0,
        Date.parse(goal.last_continued_at || 0) || 0,
        Date.parse(goal.updated_at || 0) || 0,
        latestMsgMs,
        this.latestRoomSessionFinishMs(room.id),
      );
      if (nowMs - lastActivityMs < GOAL_IDLE_DEBOUNCE_MS) continue;

      const maxAttempts = Number.isSafeInteger(goal.max_continuations) && goal.max_continuations > 0
        ? goal.max_continuations
        : DEFAULT_MAX_CONTINUATIONS;
      const nextCount = (goal.continuation_count || 0) + 1;

      if (nextCount > maxAttempts) {
        const leadBot = this.resolveTargetBot(room, { ...goal, owner_bot_id: room.lead_bot_id }, null);
        this.platform.store.save(goalRecords, {
          id: room.id,
          stalled: true,
          stall_reason: `步骤「${currentStep.title}」连续 ${maxAttempts} 次自动续推后仍无实际进展，已暂停等待处理`,
          continuation_count: maxAttempts,
          last_continued_at: nowIso,
          updated_at: nowIso,
        });
        if (leadBot) {
          const event = this.platform.store.save('platform-events', {
            id: keyOf('goal.stalled', room.id, goal.revision, nowMs),
            kind: 'event',
            type: 'goal.stalled',
            author: { kind: 'platform', id: 'platform' },
            bot_id: leadBot.id,
            space: { kind: 'room', id: room.id },
            roomId: room.id,
            time: nowIso,
            goal_id: goal.id,
            goal_title: goal.title,
            done_criteria: goal.done_criteria || '',
            current_step: currentStep,
            steps,
            guidance: '该群目标在连续自动续推后仍无实际工具进展，已触发防空转熔断。严禁继续自造离线测试或拖延：请立刻向宿主简洁汇报当前真实卡点、可行替代方案，并通过 send.prompt 请宿主拍板（或调用 update_goal 标记 awaiting_user / completed / stopped）。',
          });
          this.platform.deliveries.enqueue(
            leadBot.id,
            event,
            [{ id: keyOf('goal_loop', room.id), revision: goal.revision, kind: 'goal_loop' }],
            [],
          );
        }
        this.platform.emit('room', { id: room.id });
        this.platform.emit('execution', { room_id: room.id });
        continue;
      }

      const targetBot = this.resolveTargetBot(room, goal, currentStep);
      if (!targetBot) continue;

      this.platform.store.save(goalRecords, {
        id: room.id,
        continuation_count: nextCount,
        last_continued_at: nowIso,
        updated_at: nowIso,
      });

      const event = this.platform.store.save('platform-events', {
        id: keyOf('goal.continue', room.id, goal.revision, nextCount, nowMs),
        kind: 'event',
        type: 'goal.continue',
        author: { kind: 'platform', id: 'platform' },
        bot_id: targetBot.id,
        space: { kind: 'room', id: room.id },
        roomId: room.id,
        time: nowIso,
        goal_id: goal.id,
        goal_title: goal.title,
        done_criteria: goal.done_criteria || '',
        current_step: currentStep,
        steps,
        attempt: nextCount,
        max_attempts: maxAttempts,
        guidance: `当前群目标「${goal.title}」仍在进行中，步骤 [${currentStep.id}]「${currentStep.title}」尚未完成但全群已无在途任务（自动续推 ${nextCount}/${maxAttempts}）。请立刻采取真实行动推进闭环：1) 若本步可在授权内直接推进，立即调用真实工具/open_session 执行并更新 update_goal；2) 若当前路径在架构上走不通（如缺少入口/权限），不要原地绕圈或写离线模拟原型，立即思考可行替代路线（如复用已有隧道/Tailscale/反向拉取等）；3) 若已查明事实且必须由宿主选方案或授权生产改动，立刻用 send.prompt 请宿主拍板并将目标标记为 awaiting_user；4) 若目标已全部达成，调用 update_goal 标记 completed 并向宿主简明交付。绝不能只口头回复“下一步会做”而不发起真实动作。`,
      });
      this.platform.deliveries.enqueue(
        targetBot.id,
        event,
        [{ id: keyOf('goal_loop', room.id), revision: goal.revision, kind: 'goal_loop' }],
        [],
      );
      this.platform.emit('room', { id: room.id });
      this.platform.emit('execution', { room_id: room.id });
    }
  }
}
