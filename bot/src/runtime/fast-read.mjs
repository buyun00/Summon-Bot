import { randomUUID } from 'node:crypto';
import { listBotMemoryItems, readBotInstructions } from '../../../capabilities/bot-management/folders.mjs';
import { botMaintenanceRoomId, builtInInstructions, defaultPublicDuty, eggbotRole, groupLeadRole } from '../../../capabilities/bot-management/roles.mjs';
import { keyOf } from '../../../capabilities/platform/contract.mjs';
import { wakeupRecords } from '../../../capabilities/platform/delivery.mjs';
import { bindModel, boundModel } from '../agent/model.mjs';
import { contextTokens, roomChatMessage, textMessage } from '../context/projection.mjs';
import { now, recordKey, runtimeFailure, runtimeRecords as R } from '../storage/runtime-records.mjs';

const MAX_BATCH_SIZE = 16;
const FAST_READ_TIMEOUT_MS = 45000;
const botRef = id => ({ kind: 'bot', id });
const TRIVIAL_ACK_RE = /^(好|好的|好呀|好哒|行|行吧|可以|嗯|嗯嗯|收到|明白|知道了|了解|ok|okay|got it|thanks|thank you|谢谢|多谢|感谢|辛苦|辛苦了|赞|不错|牛|没问题|可以的|挺好|可以的谢谢)$/i;
const EGGBOT_TEAM_SIGNAL_RE = /建群|拉群|新群|加人|建人|建个|专员|分工|缺人|缺口|卡住|无人接手|交接给谁|配人|加个|谁来负责|谁负责|eggbot|团队|成员/i;

function isTrivialAck(text) {
  const cleaned = String(text || '').trim().replace(/[。！!？?，,、~～.\s]+/gu, '');
  return cleaned.length > 0 && cleaned.length <= 10 && TRIVIAL_ACK_RE.test(cleaned);
}

const roomEvent = message => ({
  id: message.id,
  kind: 'event',
  type: 'message',
  space: { kind: 'room', id: message.roomId },
  sequence: message.sequence,
  time: message.createdAt,
  author: message.author || (message.senderId === 'user'
    ? { kind: 'user', id: 'user' }
    : message.senderId === 'system'
      ? { kind: 'platform', id: 'platform' }
      : botRef(message.senderId)),
  ...(message.senderName ? { sender_name: message.senderName } : {}),
  text: message.content,
  attachments: message.attachments,
  references: message.references,
  mentions: message.mentions,
  reply_to: message.replyTo,
  ...(message.forSessionId ? { for_session_id: message.forSessionId } : {}),
  ...(message.originMessageId ? { origin_message_id: message.originMessageId } : {}),
  ...(message.prompt ? { prompt: message.prompt } : {}),
  ...(message.promptResponse ? { prompt_response: message.promptResponse } : {}),
  ...(message.promptAnswer ? { prompt_answer: message.promptAnswer } : {}),
});

// Immutable platform-shared system prompt (no per-bot or per-room fields) so every Bot in a room
// hits the exact same prompt cache prefix for both system instructions and shared room history.
const fastReadSystemPrompt = [
  '你是 Summon Bot 群聊成员的「快读收件器（fast_read）」。你只做两件事：\n' +
    '1. 结合群公开聊天记录与尾部 `fast_read_batch`（其中 `self` 标明本轮你正在替哪一位 Bot 判断，含其 ID、名称、内置角色、职责与个人长期指令；另含 `room`、`members`、`pending_message_ids`、`active_sessions`、`room_goal`、`auto_naming`），对 `pending_message_ids` 中每条新消息做二元路由判断：`quiet`（静默旁听，不唤醒主对话）或 `main`（交由主对话处理）；\n' +
    '2. 仅当判 `main` 时，给出 6–24 字自然中文进度文案（`activity`，必须以「正在…」开头，供顶部状态栏展示），例如「正在核查告警渠道」「正在评估最简方案」「正在整理排查结论」。一切具体执行、查工具、追问、纠偏和公开发言均由主对话裁决，本阶段绝不代答、不执行任何个人指令。',

  '一、消息来源与语义归属铁律：\n' +
    '- 严格区分发言者：宿主（`宿主`）、群主控或其他同伴 Bot（`名字 (bot-...)`）、系统通知（`系统`），以及消息正文中的引用片段、历史转述、贴出的日志或报错文本。\n' +
    '- 历史引用和他人转述只作为上下文背景，绝不能把引述里提到的旧指令或旧人名误判成当前宿主的直接点名。\n' +
    '- 注意 `pending_mentions` 与消息中的 `回复: msg:...`：只有真正点名当前 `self.id` 或直接回复 `self.id` 的消息才算定向指派；他人之间点名（例如 A @ B）对第三方 C 而言不是定向指派。',

  '二、角色路由矩阵（先看 `self.role`，再结合 `self.public_duty` 与 `self.instructions` 判断边界）：\n' +
    '1. 群主控（`self.role === "group-lead"`）：\n' +
    '   - 你是本群默认对话主持者与宿主搭档，负责接住宿主常规需求、开放式讨论、路线权衡与最终收口。\n' +
    '   - 判 `main` 的典型场景：\n' +
    '     a) 宿主发出常规需求、开场提问、未 @ 指定他人的消息、回复你的消息或提交交互卡片作答；\n' +
    '     b) 专员刚在群里汇报完一轮核查结果、或两位专员各自汇报完需要主控综合拍板/向宿主做一句话总结或对齐关键问题；\n' +
    '     c) 群内有人出现明显方向跑偏、冗余过度设计（例如提议高频轮询烧 Token）、或专员之间卡在等待某个宿主才能拍板的取舍，需要你出面收口；\n' +
    '     d) `room_goal` 当前阶段完成需要你推进下一步或汇总交付。\n' +
    '   - 判 `quiet` 的典型场景：\n' +
    '     a) 宿主或同伴明确 @ 了特定专员且任务已清晰落在对方手里、对方正要进场查证，此时无需群主控抢先插话表态；\n' +
    '     b) 两位专员正在做中段点对点衔接（如 A 把主机信息递给 B 方便 B 去查），尚未汇齐最终结论，等查清再由主控统一收口更清爽；\n' +
    '     c) 纯礼貌致谢、收到、自然收尾且无未闭环事项。\n' +
    '2. 领域专职成员（`self.role === "default"` 或其他业务角色）：\n' +
    '   - 本群有主控 Summon 兜底日常寒暄，专职成员**绝不为怕冷场或无增量附和（如“我赞同”）而抢话**，但**绝不在专业判断和方案把关上保持沉默**。\n' +
    '   - 在以下 5 种情况必须判 `main`：\n' +
    '     (1) 被明确 `@`（`pending_mentions` 含 `self.id`）或被直接回复；\n' +
    '     (2) 宿主提出的问题或方案讨论涉及你的专业职责/已知领域记忆（见 `self.duty`、`self.instructions`、`self.memory_topics`），需要你提供一线环境事实、实地核查或专业视角（且尚未有同岗成员正在核查同一范围）；\n' +
    '     (3) 涉及你名下在途任务（`active_sessions` 非空）的补件、改需求、叫停、纠偏或进度追问；\n' +
    '     (4) **有刺必挑**：旁听到主控或同伴抛出的结论/技术方案存在**关键事实遗漏（如漏用了你已知的现成服务/网络条件）、未验证的片面假设、或明显不合理的长期成本/复杂度**，立即判 `main` 带着一手事实进场挑刺补盲；\n' +
    '     (5) `room_goal` 的当前或下一步骤 `owner` 正是本 Bot。\n' +
    '   - 以下情况判 `quiet`：\n' +
    '     (a) 与你专业职责完全无关的话题，或纯业务偏好闲聊且主控已准确承接、无需你补任何技术事实或挑刺；\n' +
    '     (b) 同伴刚给出准确完整的方案且你完全认同、没有任何增量事实或漏洞可挑（严禁为说“我同意/说得对”判 `main`）；\n' +
    '     (c) 纯收悉、致谢、自然收尾或他人点名第三方的内部交接。\n' +
    '3. 团队孵化伙伴 EggBot（`self.role === "eggbot"`）：\n' +
    '   - 日常业务完全由群主控与领域专员自行推进，顺畅时保持静默（`quiet`）。\n' +
    '   - 仅在以下情况判 `main`：\n' +
    '     a) 被明确 `@` 或被直接回复；\n' +
    '     b) 宿主或群内正在讨论**建新群、从现有业务衍生独立群、新增长期岗位/专员、调整成员分工**，或者反复出现持续性职责却无人承接；\n' +
    '     c) 发现明显职责缺口或协作卡点（例如新建业务群漏把共享底层服务的专员挂回原群、或群里需要某领域专人但一直缺位）。\n' +
    '   - 宿主只是正常问服务器状态、查日志、聊产品细节、确认业务偏好，且现有主控与专员覆盖完整时，一律判 `quiet`。',

  '三、典型路由校准样例（帮你拿捏边界，避免过度唤醒或漏接）：\n' +
    '- 样例 1（群主控静默等专员汇齐）：新群刚建好，EggBot 交接给 `@专员A` 和 `@专员B` 分别去查服务和告警；专员 A 先查完并 `@专员B` 问一句连接线索，专员 B 回复线索。此时两路核查还没全收齐，群主控判 `quiet` 等两人汇报完毕再一起收口；当两人均交回关键核查结果、且留下需要宿主对齐的取舍时，群主控判 `main` 替宿主做总结和提问。\n' +
    '- 样例 2（认同静默 vs 有刺必挑）：宿主问“最简单怎么搞？”，主控给出了一套考虑周全且已覆盖已知基础设施的方案，专员无新事实要补则判 `quiet`（不刷附和）；但若主控提议了一套笨重轮询或漏掉了专员已知的现成环境通路，专员必须判 `main` 站出来挑刺补盲。\n' +
    '- 样例 3（专员事实纠偏）：主控在总结里误称“服务器上已经有现成的外部短信告警可以直接用”，而运维专员刚实地查过确认主机上没有任何外部告警通道。即使没被 `@`，运维专员也应判 `main` 直接补一句事实纠偏。\n' +
    '- 样例 4（EggBot 不插手日常问答）：运维群里宿主发了一段 SSH 验连命令让查服务器上跑着哪些服务，这是日常业务工作，没有建群或增员诉求，EggBot 判 `quiet`；随后宿主说“我希望有个独立群专门对接这个服务并配个长期盯监控的人”，涉及衍生新群与配专员，EggBot 立刻判 `main`。\n' +
    '- 样例 5（单条消息多 Bot 去重）：专员刚在群里汇报完并加了一句“等宿主确认偏好后再动”，此时没有新事实也没有漏洞，其他未负责收口的同伴判 `quiet`，避免无意义互致谢意循环。',

  '四、新群自动命名（仅当 `fast_read_batch` 含有 `auto_naming` 字段时触发）：\n' +
    '- 当 `auto_naming.needs_room_title === true` 时，在顶层 JSON 输出 `room_title`（2–12 字简洁中文，提炼真实主题，避开 `existing_group_names`，严禁机械截取用户原话前缀或输出“新群聊/群聊/默认群聊”）。\n' +
    '- 仅当 `auto_naming.allow_defer_naming === true` 且宿主仅发无任何主题的纯寒暄（如“你好”“在吗”）且未绑定项目目录时，才可将 `room_title` 暂设 `null`；只要包含具体事务、岗位或目标意图，必须当轮直接给出。',

  '五、严格输出格式（只输出单个合法 JSON 对象，不加 Markdown 代码块或任何解释文字）：\n' +
    '{"items":[{"message_id":"<pending_message_ids中的ID>","route":"quiet"|"main","activity":"正在...（仅route为main时填写，quiet省略）"}]}\n' +
    '- `items` 必须覆盖 `pending_message_ids` 中的全部 ID，顺序一一对应，不可遗漏。\n' +
    '- 若 `fast_read_batch` 包含 `auto_naming`，在顶层同级附加 `"room_title"` 字段。',
].join('\n\n');

const FORBIDDEN_ROOM_TITLES = new Set(['新群聊', '群聊', '未命名', '默认群聊', 'null', 'undefined', 'none']);

function cleanGeneratedLabel(value, { maxLen = 32, forbidden = null } = {}) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[「『"“'‘《【(\[]+|[」』"”'’》】)\]]+$/g, '').trim();
  text = text.replace(/[。！？!?,，；;…\.]+$/u, '').trim();
  if (!text) return null;
  if (forbidden && forbidden.has(text.toLowerCase())) return null;
  return text.slice(0, maxLen).trim() || null;
}

function cleanGeneratedDuty(value, maxLen = 240) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || ['null', 'undefined', 'none'].includes(text.toLowerCase())) return null;
  return text.slice(0, maxLen).trim() || null;
}

function cleanActivity(value) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\s+/g, ' ').trim().replace(/[。！？!?,，；;…\.]+$/u, '');
  if (!text) return null;
  if (/^(quiet|main|静默|交主对话|无需回复|跳过|忽略)/i.test(text)) return null;
  if (!/^(正在|等待|准备)/.test(text)) text = `正在${text}`;
  return text.slice(0, 48);
}

function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function fallbackDecisions(pendingIds) {
  return new Map(pendingIds.map(id => [id, { route: 'main', activity: null, fallback: true }]));
}

function parseFastReadResponse(answer, pendingIds, namingContext = null) {
  const raw = (answer?.content || [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
  const parsed = extractJsonObject(raw);
  if (!parsed) return { ok: false, reason: 'invalid_json', decisions: fallbackDecisions(pendingIds), naming: null };

  const roomTitle = namingContext?.needsRoomTitle
    ? cleanGeneratedLabel(parsed.room_title ?? parsed.roomTitle, { maxLen: 32, forbidden: FORBIDDEN_ROOM_TITLES })
    : null;
  const naming = roomTitle ? { roomTitle } : null;

  let rawItems = Array.isArray(parsed.items) ? parsed.items : null;
  if (!rawItems && pendingIds.length === 1 && (typeof parsed.route === 'string' || typeof parsed.activity === 'string')) {
    rawItems = [{ ...parsed, message_id: parsed.message_id || pendingIds[0] }];
  }
  if (!rawItems) return { ok: false, reason: 'missing_items', decisions: fallbackDecisions(pendingIds), naming };

  const byId = new Map();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.message_id === 'string' && item.message_id.trim()
      ? item.message_id.trim()
      : (pendingIds.length === 1 && rawItems.length === 1 ? pendingIds[0] : null);
    if (id && !byId.has(id)) byId.set(id, item);
  }

  const decisions = new Map();
  let hadFallback = false;
  for (const id of pendingIds) {
    const item = byId.get(id);
    const route = item?.route === 'quiet' || item?.route === 'main' ? item.route : null;
    const activity = route === 'main' ? cleanActivity(item?.activity ?? item?.status) : null;
    if (!route) {
      hadFallback = true;
      decisions.set(id, { route: 'main', activity, fallback: true });
      continue;
    }
    decisions.set(id, { route, activity, fallback: false });
  }
  return { ok: !hadFallback, reason: hadFallback ? 'incomplete_fields' : null, decisions, naming };
}

function permissionFallback(stage, connectionId) {
  const preflight = stage === 'preflight';
  return { stage, code: preflight ? 'model_grant_required' : 'connection_forbidden',
    connection_id: connectionId, route: 'main', ...(preflight ? {} : { status: 403 }),
    message: preflight ? `快读预检发现此 Bot 缺少模型连接 ${connectionId} 的授权。消息已转交群主对话。` :
      `发送快读请求前，模型连接 ${connectionId} 的权限检查未通过（宿主 403）。消息已转交群主对话。` };
}

export class FastReadRuntime {
  constructor(runtime) {
    this.runtime = runtime;
    this.platform = runtime.platform;
    this.active = new Map();
    this.cacheChains = new Map();
  }

  needsFastRead(inbox, bot, route) {
    if (!route || route.run_id || route.wait_id || route.fast_read_decision) return false;
    const event = route.event || inbox.event(route.event_id);
    if (!event || event.type !== 'message' || event.space?.kind !== 'room') return false;
    // Unanswered fallback deliveries explicitly ask the coordinator to step in directly.
    if (route.match_sources?.some(source => source.kind === 'unanswered_fallback')) {
      return false;
    }
    return true;
  }

  listActiveSessions(bot, roomId) {
    return this.platform.executions.activeRoomSessions(bot.id, roomId).map(session => ({
      session_id: session.id,
      engine: session.engine,
      status: session.status || 'idle',
      origin_message_id: session.origin_message_id || null,
      work_summary: session.work_summary || null,
      pending_requests: session.pending_input?.length ? session.pending_input : undefined,
    }));
  }

  enqueue(inbox, bot, roomId, routes) {
    if (!routes?.length || this.runtime.closed || this.runtime.draining || this.platform.draining) return;
    const key = recordKey(bot.id, roomId);
    if (this.active.has(key)) return;

    const batch = routes.slice(0, MAX_BATCH_SIZE);
    const controller = new AbortController();
    const entry = { key, botId: bot.id, roomId, controller, done: null };
    const roomRecord = this.platform.store.get('rooms', roomId);
    const liveBotRecord = this.platform.store.get('platform-bots', bot.id) || bot;
    const isAutoNaming = Boolean(
      roomRecord && roomRecord.mode === 'group' && roomRecord.id !== botMaintenanceRoomId &&
      (roomRecord.lead_bot_id === bot.id || liveBotRecord.built_in_role?.id === groupLeadRole) &&
      roomRecord.auto_title_pending,
    );
    this.runtime.setLiveActivity?.(bot.id, roomId, {
      phase: 'fast_read',
      text: isAutoNaming ? '正在理解需求并命名群聊' : '正在查看消息',
    });
    entry.done = this.runBatch(inbox, bot, roomId, batch, controller)
      .catch(error => {
        this.runtime.emit('fast_read.error', {
          bot_id: bot.id,
          room_id: roomId,
          ...this.runtime.clean.error({ code: error.code, message: error.message, status: error.status }),
        });
      })
      .finally(() => {
        this.active.delete(key);
        this.runtime.clearLiveActivity?.(bot.id, roomId, ['fast_read']);
        if (!this.runtime.closed && !this.runtime.draining) this.runtime.wake();
      });
    this.active.set(key, entry);
  }

  async runBatch(inbox, bot, roomId, batch, controller) {
    const actor = botRef(bot.id);
    const space = { kind: 'room', id: roomId };
    const botVersion = bot.control?.control_version;
    const fastReadRunId = randomUUID();
    const eventIds = batch.map(route => route.event_id);
    const conversationId = keyOf('fast_read', bot.id, roomId);
    const context = () => ({
      actor,
      execution_actor: actor,
      controls: [{ target: actor, control_version: botVersion }],
      submitted_by: actor,
      signal: controller.signal,
      origin: {
        bot_id: bot.id,
        conversation_id: conversationId,
        conversation_kind: 'fast_read',
        run_id: fastReadRunId,
        event_ids: eventIds,
        space,
      },
    });
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.runtime.closed) throw runtimeFailure('runtime_closed', 'The Bot runtime is closing', 503);
      if (this.runtime.draining || this.platform.draining)
        throw runtimeFailure('updating', 'Fast-read intake is paused for the update window', 503);
      const currentBot = this.platform.getBot(bot.id);
      if (!currentBot.enabled || currentBot.control?.control_version !== botVersion)
        throw runtimeFailure('bot_paused', 'The Bot is paused', 409);
      if (!this.platform.canReadSpace(actor, space, { actor }))
        throw runtimeFailure('access_revoked', 'Room access was revoked', 403);
      this.platform.assertRunAllowed(context());
    };

    try {
      await this.runtime.checkInstallation();
      check();

      const room = this.platform.room.room(roomId, bot.id);
      const liveBot = this.platform.store.get('platform-bots', bot.id) || bot;
      const batchSequences = batch.map(route => route.event?.sequence).filter(Number.isSafeInteger);
      const latestEnd = Math.max(this.platform.room.observationEnd(roomId, bot.id), ...batchSequences);
      const snapshot = this.platform.room.publicHistory(roomId, bot.id, latestEnd);

      const isGroupLead = room.mode === 'group' && room.id !== botMaintenanceRoomId && (
        room.lead_bot_id === bot.id || liveBot.built_in_role?.id === groupLeadRole
      );
      const needsRoomTitle = isGroupLead && room.auto_title_pending === true;
      const userMessageIds = new Set();
      for (const msg of snapshot.messages) if (msg.senderId === 'user') userMessageIds.add(msg.id);
      for (const route of batch) if (route.event?.author?.kind === 'user') userMessageIds.add(route.event_id);
      const namingContext = needsRoomTitle
        ? { needsRoomTitle, allowDeferNaming: userMessageIds.size <= 1 }
        : null;

      // Deterministic fast-paths: skip the fast_read LLM call whenever routing is 100% unambiguous.
      if (!namingContext) {
        const msgById = new Map(snapshot.messages.map(msg => [msg.id, msg]));
        const activeSessions = this.listActiveSessions(bot, roomId);
        const directMainIds = new Set();
        let directFromUser = false;
        let allRoutinePeerBotMsgs = true;
        for (const route of batch) {
          const ev = route.event;
          const stored = msgById.get(route.event_id);
          const authorKind = ev?.author?.kind || (stored?.senderId === 'user' ? 'user' : stored?.senderId === 'system' ? 'platform' : 'bot');
          const mentions = ev?.mentions || stored?.mentions || [];
          const replyToId = typeof ev?.reply_to === 'string' ? ev.reply_to : (ev?.reply_to?.id || stored?.replyTo || null);
          const repliedAuthor = replyToId ? msgById.get(replyToId)?.senderId : null;
          const promptTargetId = ev?.prompt_response?.prompt_message_id || stored?.promptResponse?.prompt_message_id || null;
          const promptAuthor = promptTargetId ? msgById.get(promptTargetId)?.senderId : null;
          const text = ev?.text ?? stored?.content ?? '';

          const mentionedSelf = mentions.includes(bot.id);
          const repliedSelf = repliedAuthor === bot.id || promptAuthor === bot.id;
          const leadUnmentionedHost = isGroupLead && authorKind === 'user' && mentions.length === 0 && !isTrivialAck(text);
          if (mentionedSelf || repliedSelf || leadUnmentionedHost) {
            directMainIds.add(route.event_id);
            if (authorKind === 'user') directFromUser = true;
          }
          if (authorKind !== 'bot' || mentionedSelf || repliedSelf || EGGBOT_TEAM_SIGNAL_RE.test(text)) {
            allRoutinePeerBotMsgs = false;
          }
        }
        if (directMainIds.size > 0) {
          const fastDecisions = new Map();
          const activity = directFromUser ? '正在查看你的消息' : '正在承接同伴交接';
          for (const id of eventIds) {
            fastDecisions.set(id, directMainIds.has(id)
              ? { route: 'main', activity, fallback: false }
              : { route: 'quiet', activity: null, fallback: false });
          }
          await this.commitDecisions(inbox, bot, room, batch, fastDecisions, null, check);
          return;
        }
        if (liveBot.built_in_role?.id === eggbotRole && allRoutinePeerBotMsgs && activeSessions.length === 0) {
          const quietDecisions = new Map(eventIds.map(id => [id, { route: 'quiet', activity: null, fallback: false }]));
          await this.commitDecisions(inbox, bot, room, batch, quietDecisions, null, check);
          return;
        }
      }

      const resolved = this.platform.models.resolveForBot(bot, 'fast_read');
      const blocker = this.platform.modelAccessBlocker(actor, resolved?.connection_id);
      if (!resolved || blocker) {
        return await this.commitFallback(inbox, bot, roomId, batch, check,
          blocker?.message || 'Fast-read model is unavailable', blocker?.code || 'connection_unconfigured',
          blocker?.code === 'model_grant_required' ? permissionFallback('preflight', resolved.connection_id) : null);
      }

      const modelSelection = bindModel(this.runtime.model, resolved, 'fast_read');
      const model = boundModel(this.runtime.model, modelSelection);

      const existingGroupNames = needsRoomTitle
        ? this.platform.store.list('rooms')
            .filter(item => item.mode === 'group' && item.id !== roomId && item.name)
            .map(item => item.name)
            .slice(0, 40)
        : [];

      const members = [...(room.members || [])].sort((a, b) => (a === 'user' ? -1 : b === 'user' ? 1 : a.localeCompare(b))).map(memberId => {
        if (memberId === 'user') return { id: 'user', kind: 'user', name: '用户' };
        const memberBot = this.platform.store.get('platform-bots', memberId);
        return {
          id: memberId,
          kind: 'bot',
          name: memberBot?.name || memberId,
          role: memberBot?.built_in_role?.id || 'default',
        };
      });
      const systemMessage = {
        role: 'system',
        timestamp: Date.parse(room.createdAt) || 0,
        content: fastReadSystemPrompt,
      };
      const summaryThrough = snapshot.summary?.through ?? null;
      const prefix = snapshot.summary
        ? [textMessage({
            type: 'derived_history',
            room: roomId,
            covered_through: snapshot.summary.through,
            text: snapshot.summary.summary,
          }, snapshot.summary.time)]
        : [];
      const pendingSet = new Set(eventIds);
      const compactEventForFastRead = ev => {
        if (!ev.text) return ev;
        const limit = pendingSet.has(ev.id) ? 260 : 100;
        if (ev.text.length <= limit) return ev;
        return { ...ev, text: `${ev.text.slice(0, limit)}…` };
      };
      const rawHistoryEvents = snapshot.messages.map(roomEvent);
      const seenPublicIds = new Set(rawHistoryEvents.map(ev => ev.id));
      for (const route of batch) {
        if (!seenPublicIds.has(route.event_id) && route.event) {
          rawHistoryEvents.push(route.event);
          seenPublicIds.add(route.event_id);
        }
      }
      // Keep at most the 1 immediately preceding non-pending message (concise) plus all pending messages.
      const firstPendingIdx = rawHistoryEvents.findIndex(ev => pendingSet.has(ev.id));
      const sliceStart = firstPendingIdx > 1 ? firstPendingIdx - 1 : 0;
      const publicMessages = rawHistoryEvents.slice(sliceStart).map(ev => ({
        ...roomChatMessage(compactEventForFastRead(ev)),
        public_event_id: ev.id,
      }));
      const activeSessions = this.listActiveSessions(bot, roomId);
      const roomGoal = this.platform.goals?.view(roomId) || null;
      const memberNameById = new Map(members.map(member => [member.id, member.name]));
      const pendingMentions = {};
      for (const route of batch) {
        const mentionIds = route.event?.mentions || [];
        if (mentionIds.length) {
          pendingMentions[route.event_id] = mentionIds.map(id => ({ id, name: memberNameById.get(id) || id }));
        }
      }
      const selfRole = liveBot.built_in_role?.id || 'default';
      const rawInstructions = selfRole === 'default' ? readBotInstructions(this.platform.dataRoot, liveBot) : '';
      const memoryTopics = selfRole === 'default'
        ? listBotMemoryItems(this.platform.dataRoot, liveBot.id).slice(0, 8).map(item => item.item_id)
        : [];
      const tail = textMessage({
        type: 'fast_read_batch',
        self: {
          id: liveBot.id,
          name: liveBot.name,
          role: selfRole,
          duty: (defaultPublicDuty(liveBot) || '').slice(0, 48),
          ...(rawInstructions ? { instructions: rawInstructions.slice(0, 120) } : {}),
          ...(memoryTopics.length ? { memory_topics: memoryTopics } : {}),
        },
        room: {
          id: room.id,
          name: room.name || room.id,
          ...(room.workspace?.name || room.workspace?.path ? { workspace: room.workspace.name || room.workspace.path } : {}),
        },
        members,
        pending_message_ids: eventIds,
        ...(Object.keys(pendingMentions).length ? { pending_mentions: pendingMentions } : {}),
        ...(activeSessions.length ? { active_sessions: activeSessions } : {}),
        ...(roomGoal && ['active', 'awaiting_user'].includes(roomGoal.status) ? {
          room_goal: {
            title: roomGoal.title,
            status: roomGoal.status,
            owner_bot_id: roomGoal.owner_bot_id,
            progress: roomGoal.progress,
            steps: roomGoal.steps.map(s => ({ id: s.id, title: s.title, owner: s.owner, status: s.status })),
          },
        } : {}),
        ...(namingContext ? {
          auto_naming: {
            needs_room_title: needsRoomTitle,
            allow_defer_naming: namingContext.allowDeferNaming,
            ...(room.workspace?.name || room.workspace?.path ? { workspace: room.workspace.name || room.workspace.path } : {}),
            ...(existingGroupNames.length ? { existing_group_names: existingGroupNames } : {}),
          },
        } : {}),
      });

      const maxTokens = Math.max(128, Math.min(model.maxTokens, Math.floor(model.contextWindow * 0.25), Math.max(512, eventIds.length * 160 + 256)));
      const physicalBudget = Math.floor(model.contextWindow * 0.85);
      const inputBudget = Math.max(1024, Math.min(physicalBudget, model.contextWindow - maxTokens - 512));
      let keptPrefix = prefix;
      let keptPublic = publicMessages;
      const isPending = message => pendingSet.has(message.public_event_id);
      while (contextTokens([systemMessage, ...keptPrefix, ...keptPublic, tail]) > inputBudget) {
        const nonPendingCount = keptPublic.findIndex(isPending);
        const removable = nonPendingCount === -1 ? keptPublic.length : nonPendingCount;
        if (removable > 0) {
          const dropCount = Math.max(1, Math.floor(removable / 2));
          keptPublic = keptPublic.slice(dropCount);
          continue;
        }
        if (keptPrefix.length) {
          keptPrefix = [];
          continue;
        }
        const originals = keptPublic.filter(isPending);
        if (originals.length < keptPublic.length) {
          keptPublic = originals;
          continue;
        }
        if (batch.length === 1) throw runtimeFailure('context_limit', 'The room message and execution context exceed the model window', 413);
        return this.runBatch(inbox, bot, roomId, batch.slice(0, Math.ceil(batch.length / 2)), controller);
      }
      const messages = [systemMessage, ...keptPrefix, ...keptPublic, tail];

      const priorState = inbox.store.getRecord(R.fastRead, roomId);
      let cacheSessionId;
      if (['openai-codex-responses', 'openai-responses'].includes(model.api)) {
        // Share one platform-global prompt_cache_key across all fast_read calls so the immutable
        // ~2,432-token fastReadSystemPrompt stays hot across every room and every Bot.
        cacheSessionId = 'summon-fast-read-v1';
      }
      // Serialize LLM calls sharing the same sticky WebSocket cacheSessionId (each call takes ~1.6s)
      // so concurrent bots reuse the exact same warm backend connection instead of hitting cached.busy.
      let releaseCacheSlot = null;
      if (cacheSessionId) {
        const prev = this.cacheChains.get(cacheSessionId) || Promise.resolve();
        let doneSlot;
        const next = new Promise(r => { doneSlot = r; });
        const tailChain = prev.then(() => next);
        this.cacheChains.set(cacheSessionId, tailChain);
        releaseCacheSlot = () => {
          if (this.cacheChains.get(cacheSessionId) === tailChain) this.cacheChains.delete(cacheSessionId);
          doneSlot();
        };
        try {
          await Promise.race([
            prev,
            new Promise((_, rejectAbort) => {
              if (controller.signal.aborted) rejectAbort(controller.signal.reason || runtimeFailure('cancelled', 'Cancelled', 409));
              else controller.signal.addEventListener('abort', () => rejectAbort(controller.signal.reason || runtimeFailure('cancelled', 'Cancelled', 409)), { once: true });
            }),
          ]);
          check();
        } catch (waitErr) {
          releaseCacheSlot();
          throw waitErr;
        }
      }
      const cachePoint = keptPublic.at(-1);
      const roomCache = cachePoint
        ? {
            current: cachePoint.content[0].text,
            throughMessageId: cachePoint.public_event_id,
            previous: keptPublic.find(message => message.public_event_id === priorState?.cache_through_message_id)?.content[0].text,
          }
        : undefined;

      check();
      const estimate = contextTokens(messages);
      const lease = this.platform.acquireModel(context(), { reserve_tokens: estimate + maxTokens });
      let beforeFetchError = null;
      let answer;
      try {
        const stream = this.runtime.engine.provider.stream(model, { messages }, {
          signal: controller.signal,
          maxTokens,
          timeoutMs: FAST_READ_TIMEOUT_MS,
          reasoning: modelSelection.thinking_level ?? 'off',
          roomCache,
          cacheSessionId,
          usageContext: {
            purpose: 'fast_read',
            botId: bot.id,
            roomId,
            sessionId: conversationId,
            runId: fastReadRunId,
            chargeAccount: 'host',
            hostUsageId: lease.id,
            submittedBy: actor,
          },
          beforeFetch: async () => {
            try {
              await this.runtime.checkInstallation();
              check();
              if (!this.platform.canUseModel(actor, modelSelection.connection_id)) {
                throw runtimeFailure('connection_forbidden', 'The fast-read model connection is no longer authorized', 403,
                  permissionFallback('before_fetch', modelSelection.connection_id));
              }
              boundModel(this.runtime.model, modelSelection);
            } catch (error) {
              beforeFetchError = error;
              throw error;
            }
          },
        });
        answer = await stream.result();
        const tokens = answer?.generationBudget?.input == null || answer?.generationBudget?.output == null
          ? undefined
          : answer.generationBudget.input + answer.generationBudget.output;
        lease.finish({ tokens, outcome: answer?.stopReason || 'unknown' });
      } catch (error) {
        lease.finish({ outcome: 'failed' });
        throw beforeFetchError || error;
      } finally {
        releaseCacheSlot?.();
      }

      if (beforeFetchError) throw beforeFetchError;
      check();
      if (answer?.stopReason !== 'stop') {
        throw runtimeFailure('fast_read_model_error', answer?.errorMessage || 'Fast-read model did not finish cleanly', 503);
      }

      const parsed = parseFastReadResponse(answer, eventIds, namingContext);
      await this.commitDecisions(inbox, bot, room, batch, parsed.decisions, answer.roomCacheThroughMessageId, check, parsed.reason, null, parsed.naming);
    } catch (error) {
      const code = error.code || 'fast_read_error';
      if (code === 'access_revoked' || code === 'room_forbidden') {
        if (!this.platform.canReadSpace(actor, space, { actor })) {
          this.runtime.discard(inbox, batch, 'access_revoked');
        }
        return;
      }
      if (controller.signal.aborted || ['bot_paused', 'updating', 'runtime_closed', 'cancelled'].includes(code)) {
        return;
      }
      try {
        await this.commitFallback(inbox, bot, roomId, batch, check, error.message || 'Fast-read failed', code,
          code === 'connection_forbidden' && error.details?.stage === 'before_fetch' ? error.details : null);
      } catch (commitError) {
        if (!controller.signal.aborted && !['bot_paused', 'updating', 'runtime_closed', 'access_revoked', 'room_forbidden'].includes(commitError.code)) {
          throw commitError;
        }
      }
    }
  }

  async commitFallback(inbox, bot, roomId, batch, check, message, code, diagnostic = null) {
    const decisions = fallbackDecisions(batch.map(route => route.event_id));
    const room = { id: roomId, name: roomId };
    await this.commitDecisions(inbox, bot, room, batch, decisions, null, check, `${code}: ${message}`, diagnostic);
  }

  async commitDecisions(inbox, bot, room, batch, decisions, cacheThroughMessageId, check, fallbackReason = null, diagnostic = null, naming = null) {
    const roomId = room.id;
    check();

    const quietEventIds = [];
    const mainEventIds = [];
    const fallbackEventIds = [];
    let maxSeqRoute = null;
    let maxQuietPos = null;
    let plannedActivity = null;

    inbox.store.transaction(() => {
      for (const route of batch) {
        const live = inbox.store.getRecord(R.route, route.id);
        if (!live || live.state !== 'pending' || live.run_id || live.fast_read_decision) continue;
        const seq = route.event?.sequence ?? 0;
        if (!maxSeqRoute || seq > (maxSeqRoute.event?.sequence ?? 0)) maxSeqRoute = route;
        const decision = decisions.get(route.event_id) || { route: 'main', activity: null, fallback: true };
        if (decision.route === 'quiet') {
          inbox.store.putRecord(R.route, {
            ...live,
            state: 'processed',
            fast_read_decision: 'quiet',
            processed_at: now(),
          });
          quietEventIds.push(route.event_id);
          if (Number.isSafeInteger(seq) && (!maxQuietPos || seq > maxQuietPos.sequence)) {
            maxQuietPos = { id: route.event_id, sequence: seq };
          }
        } else {
          inbox.store.putRecord(R.route, {
            ...live,
            fast_read_decision: 'main',
            ...(decision.fallback ? { fast_read_fallback: true } : {}),
            ...(decision.fallback && diagnostic ? { fast_read_diagnostic: diagnostic } : {}),
            fast_read_at: now(),
          });
          mainEventIds.push(route.event_id);
          if (decision.activity) plannedActivity = decision.activity;
          if (decision.fallback) fallbackEventIds.push(route.event_id);
        }
      }
      const prior = inbox.store.getRecord(R.fastRead, roomId);
      const maxSeq = maxSeqRoute?.event?.sequence ?? 0;
      const nextSeq = Math.max(prior?.read_through_sequence ?? 0, maxSeq);
      const nextId = maxSeq > (prior?.read_through_sequence ?? 0)
        ? maxSeqRoute.event_id
        : (prior?.read_through_id ?? maxSeqRoute?.event_id ?? null);
      inbox.store.putRecord(R.fastRead, {
        ...prior,
        id: roomId,
        bot_id: bot.id,
        room_id: roomId,
        read_through_id: nextId,
        read_through_sequence: nextSeq,
        cache_through_message_id: cacheThroughMessageId ?? prior?.cache_through_message_id ?? null,
        updated_at: now(),
      });
    });

    if (naming && (naming.roomTitle || naming.leadName)) {
      try {
        this.platform.applyAutoGroupNaming?.(roomId, bot.id, naming);
      } catch {}
    }

    if (mainEventIds.length) {
      for (const eventId of mainEventIds) {
        this.platform.room?.ackMentionedMessage?.(roomId, eventId, bot.id, '收到');
      }
      this.runtime.setLiveActivity?.(bot.id, roomId, {
        phase: 'planned',
        text: plannedActivity || '正在分析需求',
      });
    } else {
      this.runtime.clearLiveActivity?.(bot.id, roomId, ['fast_read']);
    }

    if (quietEventIds.length) {
      this.runtime.consumeDeliveries(inbox, quietEventIds);
      if (maxQuietPos) {
        this.platform.deliveries.advanceObservationQuiet(bot.id, roomId, maxQuietPos, quietEventIds);
      } else {
        this.platform.deliveries.releaseSuspendedObservation(bot.id, roomId, quietEventIds);
      }
      const base = this.platform.store.get(wakeupRecords, keyOf('room_base', bot.id, roomId));
      if (base?.observation && base.enabled && base.member_active !== false && !base.observation.pending) {
        this.platform.deliveries.queueDueObservation(base);
      }
    }

    this.runtime.emit('fast_read.completed', {
      bot_id: bot.id,
      room_id: roomId,
      quiet: quietEventIds.length,
      main: mainEventIds.length,
      fallback: fallbackEventIds.length,
    });
    if (fallbackEventIds.length) {
      this.runtime.emit('fast_read.fallback', {
        bot_id: bot.id,
        room_id: roomId,
        event_ids: fallbackEventIds,
        reason: fallbackReason || 'incomplete_fields',
      });
    }
  }

  isActive(botId, roomId) {
    return this.active.has(recordKey(botId, roomId));
  }

  isActiveBot(botId) {
    for (const entry of this.active.values()) {
      if (entry.botId === botId) return true;
    }
    return false;
  }

  isActiveRoom(roomId) {
    for (const entry of this.active.values()) {
      if (entry.roomId === roomId) return true;
    }
    return false;
  }

  stopBot(botId) {
    const entries = [...this.active.values()].filter(entry => entry.botId === botId);
    for (const entry of entries) entry.controller.abort(runtimeFailure('bot_paused', 'Bot was explicitly stopped', 409));
    return Promise.allSettled(entries.map(entry => entry.done));
  }

  drainActive() {
    return [...this.active.values()].map(entry => ({
      id: entry.key,
      kind: 'fast_read',
      bot_id: entry.botId,
      room_id: entry.roomId,
      status: 'running',
    }));
  }

  async close() {
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort(runtimeFailure('runtime_closed', 'Bot runtime is closing', 503));
    await Promise.allSettled(entries.map(entry => entry.done));
  }
}
