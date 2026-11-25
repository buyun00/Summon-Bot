'use strict';

globalThis.SummonCanvasOverview = (() => {
  const COL_GAP = 78;
  const ROW_GAP = 14;
  const ROOT_GAP = 22;
  const MAX_INITIAL_ITEMS = 8;
  const MIN_SCALE = 0.35;
  const MAX_SCALE = 1.85;

  const cv = {
    expanded: new Set(),
    showAll: new Set(),
    selectedNodeId: null,
    inspector: null, // { kind: 'execution'|'file'|'memory'|'bot', ... }
    inspectorLoading: false,
    inspectorData: null,
    inspectorFileRev: null,
    x: 64,
    y: 72,
    scale: 1,
    initialized: false,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    panStartX: 0,
    panStartY: 0,
    dragMoved: false,
    animFrame: 0,
    layoutNodes: new Map(),
    layoutEdges: [],
    detachedOpen: false,
  };

  let ctx = null;

  function setContext(nextCtx) {
    ctx = nextCtx;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const diff = Date.now() - ms;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    const days = Math.floor(diff / 86400000);
    if (days < 7) return `${days} 天前`;
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(ms));
  }

  function cleanSummary(raw, fallback = '') {
    let text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    // Strip raw JSON envelopes if an old execution stored stringified JSON as output summary.
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        const extracted = parsed?.summary || parsed?.title || parsed?.message || parsed?.text || parsed?.result || '';
        if (typeof extracted === 'string' && extracted.trim()) text = extracted.replace(/\s+/g, ' ').trim();
        else return fallback || '结构化执行输出（点开可查看详情）';
      } catch { /* keep text */ }
    }
    return text.length > 110 ? text.slice(0, 108) + '…' : text;
  }

  function memoryText(item) {
    if (typeof item === 'string') return item;
    return item?.summary || item?.content || item?.text || item?.title || item?.note || item?.fact || '';
  }

  function executionSummary(item) {
    const isLive = ctx.LIVE_EXEC_STATUSES.has(item.status);
    const needsInput = ['needs_input', 'awaiting_input'].includes(item.status);
    const fallback = `${ctx.executionLabel(item)} · ${ctx.labels[item.status] || item.status || '未知'}`;
    if (needsInput) return cleanSummary(item.pending_requests?.[0]?.question || item.live_progress || item.work_summary, '等待你的确认或回复');
    if (isLive) return cleanSummary(item.live_progress || item.work_summary, '正在执行任务…');
    if (item.status === 'failed' && item.last_error?.message) {
      return cleanSummary(item.work_summary || item.last_error.message, fallback);
    }
    return cleanSummary(item.work_summary || item.live_progress, fallback);
  }

  function botRoleOrder(room, bot) {
    if (room?.lead_bot_id === bot.id || bot.role_id === 'group-lead') return 0;
    if (bot.role_id === 'eggbot') return 2;
    return 1;
  }

  function botRoleBadge(room, bot) {
    if (room?.lead_bot_id === bot.id || bot.role_id === 'group-lead') return '主控';
    if (bot.role_id === 'eggbot') return '孵化';
    return '';
  }

  function collectData() {
    const { state } = ctx;
    const allBots = [...(state.bots || []), ...(state.archivedBots || [])];
    const botMap = new Map(allBots.map(b => [b.id, b]));
    const activeRooms = (state.rooms || []).filter(r => r.mode === 'group' && !r.archived_at);
    const archivedRooms = [
      ...(state.archivedRooms || []).filter(r => r.mode === 'group'),
      ...(state.rooms || []).filter(r => r.mode === 'group' && r.archived_at),
    ];
    const allExecutions = state.executions || [];
    const allFiles = state.files || [];

    // Index executions by roomId and botId
    const execsByRoom = new Map();
    const execsByRoomBot = new Map();
    const orphanExecs = [];
    for (const ex of allExecutions) {
      const rId = ex.space?.kind === 'room' ? ex.space.id : null;
      const bId = ex.execution_actor?.id || ex.bot_id || null;
      if (rId) {
        if (!execsByRoom.has(rId)) execsByRoom.set(rId, []);
        execsByRoom.get(rId).push(ex);
        if (bId) {
          const k = `${rId}::${bId}`;
          if (!execsByRoomBot.has(k)) execsByRoomBot.set(k, []);
          execsByRoomBot.get(k).push(ex);
        }
      } else {
        orphanExecs.push(ex);
      }
    }
    const sortExecs = list => list.sort((a, b) => {
      const aLive = ctx.LIVE_EXEC_STATUSES.has(a.status) ? 0 : 1;
      const bLive = ctx.LIVE_EXEC_STATUSES.has(b.status) ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    });
    for (const list of execsByRoom.values()) sortExecs(list);
    for (const list of execsByRoomBot.values()) sortExecs(list);
    sortExecs(orphanExecs);

    // Index files by roomId and botId
    const filesByRoom = new Map();
    const filesByBot = new Map();
    const deletedRoomFiles = [];
    for (const file of allFiles) {
      if (file.deleted_room) {
        deletedRoomFiles.push(file);
      } else if (file.space?.kind === 'room') {
        if (!filesByRoom.has(file.space.id)) filesByRoom.set(file.space.id, []);
        filesByRoom.get(file.space.id).push(file);
      } else if (file.space?.kind === 'bot') {
        if (!filesByBot.has(file.space.id)) filesByBot.set(file.space.id, []);
        filesByBot.get(file.space.id).push(file);
      }
    }

    // Merge room_files when /api/files hasn't returned them yet
    const mergeFiles = (primary = [], fallback = []) => {
      const map = new Map();
      for (const f of [...primary, ...fallback]) {
        if (f?.id && !map.has(f.id)) map.set(f.id, f);
      }
      return [...map.values()];
    };

    // Find bots not in any active group
    const activeBotIds = new Set();
    for (const room of activeRooms) {
      for (const id of room.members || []) if (id !== 'user') activeBotIds.add(id);
    }
    const unassignedBots = (state.bots || []).filter(b => !activeBotIds.has(b.id));
    const archivedBots = state.archivedBots || [];

    // Sort active rooms: live executions first, then recent activity
    const sortedActiveRooms = [...activeRooms].sort((a, b) => {
      const aLive = (execsByRoom.get(a.id) || []).some(e => ctx.LIVE_EXEC_STATUSES.has(e.status)) ? 0 : 1;
      const bLive = (execsByRoom.get(b.id) || []).some(e => ctx.LIVE_EXEC_STATUSES.has(e.status)) ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return String(b.lastMessage?.createdAt || b.updatedAt || '').localeCompare(String(a.lastMessage?.createdAt || a.updatedAt || ''));
    });

    return {
      botMap,
      activeRooms: sortedActiveRooms,
      archivedRooms,
      execsByRoom,
      execsByRoomBot,
      orphanExecs,
      filesByRoom,
      filesByBot,
      deletedRoomFiles,
      unassignedBots,
      archivedBots,
      mergeFiles,
    };
  }

  function buildBotNode(room, bot, data) {
    const roomId = room ? room.id : '__unassigned__';
    const nodeId = `bot:${roomId}:${bot.id}`;
    const execs = room
      ? (data.execsByRoomBot.get(`${room.id}::${bot.id}`) || [])
      : data.orphanExecs.filter(e => (e.execution_actor?.id || e.bot_id) === bot.id);
    const allMems = bot.memory_items || [];
    const mems = room
      ? allMems.filter(m => {
          const scopes = Array.isArray(m.applies_to) ? m.applies_to : [];
          if (!scopes.length) return true;
          return scopes.some(s => s.kind === 'bot' || (s.kind === 'room' && s.id === room.id));
        })
      : allMems;
    const privateFiles = data.filesByBot.get(bot.id) || [];
    const liveExecs = execs.filter(e => ctx.LIVE_EXEC_STATUSES.has(e.status));
    const needsInput = execs.some(e => ['needs_input', 'awaiting_input'].includes(e.status));

    const categories = [];
    if (execs.length) {
      const catId = `cat:execs:${roomId}:${bot.id}`;
      const showAll = cv.showAll.has(catId);
      const visible = showAll ? execs : execs.slice(0, MAX_INITIAL_ITEMS);
      const execChildren = visible.map(ex => {
        const key = ctx.refKey(ex.execution_ref);
        return {
          id: `exec:${roomId}:${bot.id}:${key}`,
          kind: 'execution',
          w: 304,
          h: 92,
          data: { exec: ex, room, bot },
          live: ctx.LIVE_EXEC_STATUSES.has(ex.status),
          children: [],
        };
      });
      if (!showAll && execs.length > MAX_INITIAL_ITEMS) {
        execChildren.push({
          id: `more:${catId}`,
          kind: 'more',
          w: 196,
          h: 44,
          data: { targetId: catId, remaining: execs.length - MAX_INITIAL_ITEMS },
          children: [],
        });
      }
      categories.push({
        id: catId,
        kind: 'category',
        w: 224,
        h: 58,
        live: liveExecs.length > 0,
        data: {
          catType: 'execs',
          icon: 'computer',
          title: '执行对话',
          count: execs.length,
          liveCount: liveExecs.length,
          needsInput,
        },
        children: execChildren,
      });
    }
    if (mems.length) {
      const catId = `cat:mems:${roomId}:${bot.id}`;
      const showAll = cv.showAll.has(catId);
      const visible = showAll ? mems : mems.slice(0, MAX_INITIAL_ITEMS);
      const memChildren = visible.map((mem, idx) => ({
        id: `mem:${roomId}:${bot.id}:${mem.id || idx}`,
        kind: 'memory',
        w: 284,
        h: 84,
        data: { memory: mem, room, bot },
        children: [],
      }));
      if (!showAll && mems.length > MAX_INITIAL_ITEMS) {
        memChildren.push({
          id: `more:${catId}`,
          kind: 'more',
          w: 196,
          h: 44,
          data: { targetId: catId, remaining: mems.length - MAX_INITIAL_ITEMS },
          children: [],
        });
      }
      categories.push({
        id: catId,
        kind: 'category',
        w: 224,
        h: 58,
        data: { catType: 'mems', icon: 'spark', title: '沉淀记忆', count: mems.length },
        children: memChildren,
      });
    }
    if (privateFiles.length) {
      const catId = `cat:bfiles:${roomId}:${bot.id}`;
      const showAll = cv.showAll.has(catId);
      const visible = showAll ? privateFiles : privateFiles.slice(0, MAX_INITIAL_ITEMS);
      const fileChildren = visible.map(file => ({
        id: `file:${catId}:${file.id}`,
        kind: 'file',
        w: 256,
        h: 68,
        data: { file, room, bot, scope: 'bot' },
        children: [],
      }));
      if (!showAll && privateFiles.length > MAX_INITIAL_ITEMS) {
        fileChildren.push({
          id: `more:${catId}`,
          kind: 'more',
          w: 196,
          h: 44,
          data: { targetId: catId, remaining: privateFiles.length - MAX_INITIAL_ITEMS },
          children: [],
        });
      }
      categories.push({
        id: catId,
        kind: 'category',
        w: 224,
        h: 58,
        data: { catType: 'bfiles', icon: 'knowledge', title: '私有资料', count: privateFiles.length },
        children: fileChildren,
      });
    }

    return {
      id: nodeId,
      kind: 'bot',
      w: 266,
      h: 88,
      live: liveExecs.length > 0,
      data: {
        bot,
        room,
        badge: botRoleBadge(room, bot),
        execCount: execs.length,
        liveCount: liveExecs.length,
        needsInput,
        memCount: mems.length,
        fileCount: privateFiles.length,
      },
      children: categories,
    };
  }

  function buildRoomNode(room, data) {
    const nodeId = `room:${room.id}`;
    const members = (room.members || [])
      .filter(id => id !== 'user')
      .map(id => data.botMap.get(id))
      .filter(Boolean)
      .sort((a, b) => botRoleOrder(room, a) - botRoleOrder(room, b));
    const roomFiles = data.mergeFiles(data.filesByRoom.get(room.id), room.room_files);
    const roomExecs = data.execsByRoom.get(room.id) || [];
    const liveCount = roomExecs.filter(e => ctx.LIVE_EXEC_STATUSES.has(e.status)).length;

    const children = members.map(bot => buildBotNode(room, bot, data));
    if (roomFiles.length) {
      const catId = `cat:rfiles:${room.id}`;
      const showAll = cv.showAll.has(catId);
      const visible = showAll ? roomFiles : roomFiles.slice(0, MAX_INITIAL_ITEMS);
      const fileChildren = visible.map(file => ({
        id: `file:${catId}:${file.id}`,
        kind: 'file',
        w: 256,
        h: 68,
        data: { file, room, scope: 'room' },
        children: [],
      }));
      if (!showAll && roomFiles.length > MAX_INITIAL_ITEMS) {
        fileChildren.push({
          id: `more:${catId}`,
          kind: 'more',
          w: 196,
          h: 44,
          data: { targetId: catId, remaining: roomFiles.length - MAX_INITIAL_ITEMS },
          children: [],
        });
      }
      children.push({
        id: catId,
        kind: 'category',
        w: 224,
        h: 58,
        data: { catType: 'rfiles', icon: 'knowledge', title: '群共享资料', count: roomFiles.length },
        children: fileChildren,
      });
    }

    return {
      id: nodeId,
      kind: 'room',
      w: 282,
      h: 88,
      live: liveCount > 0,
      data: {
        room,
        memberCount: members.length,
        execCount: roomExecs.length,
        liveCount,
        fileCount: roomFiles.length,
      },
      children,
    };
  }

  function buildTree() {
    const data = collectData();
    const roots = data.activeRooms.map(room => buildRoomNode(room, data));

    const archiveChildren = [];
    for (const room of data.archivedRooms) {
      archiveChildren.push(buildRoomNode(room, data));
    }
    for (const bot of [...data.unassignedBots, ...data.archivedBots]) {
      archiveChildren.push(buildBotNode(null, bot, data));
    }
    if (data.deletedRoomFiles.length) {
      const catId = 'cat:deleted-files';
      archiveChildren.push({
        id: catId,
        kind: 'category',
        w: 224,
        h: 58,
        data: { catType: 'dfiles', icon: 'archive', title: '已删群资料', count: data.deletedRoomFiles.length },
        children: data.deletedRoomFiles.slice(0, MAX_INITIAL_ITEMS).map(file => ({
          id: `file:${catId}:${file.id}`,
          kind: 'file',
          w: 256,
          h: 68,
          data: { file, scope: 'deleted' },
          children: [],
        })),
      });
    }

    if (archiveChildren.length) {
      roots.push({
        id: 'bucket:archive',
        kind: 'archive-bucket',
        w: 282,
        h: 68,
        data: {
          archivedRooms: data.archivedRooms.length,
          otherBots: data.unassignedBots.length + data.archivedBots.length,
          deletedFiles: data.deletedRoomFiles.length,
        },
        children: archiveChildren,
      });
    }

    return roots;
  }

  function computeLayout(roots) {
    const nodes = new Map();
    const edges = [];

    function isExpanded(node) {
      return node.children.length > 0 && cv.expanded.has(node.id);
    }

    function measure(node) {
      if (!isExpanded(node)) {
        node.subtreeH = node.h;
        return node.subtreeH;
      }
      let total = 0;
      for (let i = 0; i < node.children.length; i++) {
        if (i > 0) total += ROW_GAP;
        total += measure(node.children[i]);
      }
      node.subtreeH = Math.max(node.h, total);
      return node.subtreeH;
    }

    function place(node, x, topY, depth) {
      node.depth = depth;
      node.x = Math.round(x);
      node.y = Math.round(topY + (node.subtreeH - node.h) / 2);
      node.expanded = isExpanded(node);
      nodes.set(node.id, node);

      if (!node.expanded) return;
      let childrenTotal = 0;
      for (let i = 0; i < node.children.length; i++) {
        if (i > 0) childrenTotal += ROW_GAP;
        childrenTotal += node.children[i].subtreeH;
      }
      let curY = topY + (node.subtreeH - childrenTotal) / 2;
      const childX = x + node.w + COL_GAP;
      for (const child of node.children) {
        place(child, childX, curY, depth + 1);
        edges.push({
          id: `${node.id}-->${child.id}`,
          from: node,
          to: child,
          live: Boolean(child.live),
        });
        curY += child.subtreeH + ROW_GAP;
      }
    }

    let curY = 0;
    for (let i = 0; i < roots.length; i++) {
      if (i > 0) curY += ROOT_GAP;
      measure(roots[i]);
      place(roots[i], 0, curY, 0);
      curY += roots[i].subtreeH;
    }

    return { nodes, edges };
  }

  function bezierPath(edge) {
    const x1 = edge.from.x + edge.from.w;
    const y1 = edge.from.y + edge.from.h / 2;
    const x2 = edge.to.x;
    const y2 = edge.to.y + edge.to.h / 2;
    const dx = Math.max(36, (x2 - x1) * 0.52);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function renderNodeInner(node) {
    const { esc, icon, avatar, groupAvatar, labels } = ctx;
    const hasKids = node.children.length > 0;
    const toggleDot = hasKids
      ? `<span class="cv-expand-pill ${node.expanded ? 'is-open' : ''}" aria-hidden="true">${node.expanded ? '‹' : `${node.children.length} ›`}</span>`
      : '';

    if (node.kind === 'room') {
      const { room, memberCount, execCount, liveCount, fileCount } = node.data;
      const archived = Boolean(room.archived_at);
      const stats = [
        `${memberCount} 位伙伴`,
        liveCount ? `<em class="cv-stat-live">${liveCount} 进行中</em>` : execCount ? `${execCount} 条执行` : '',
        fileCount ? `${fileCount} 份资料` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="cv-node-body cv-room-node">
        <div class="cv-node-avatar">${groupAvatar(room, 44, '')}</div>
        <div class="cv-node-copy">
          <div class="cv-node-title-row">
            <strong>${esc(room.name)}</strong>
            ${archived ? '<span class="cv-chip">已归档</span>' : ''}
            ${liveCount ? '<i class="cv-live-dot" title="有任务正在进行"></i>' : ''}
          </div>
          ${room.workspace?.name ? `<div class="cv-node-sub">${icon('folder', 12)}<span>${esc(room.workspace.name)}</span></div>` : ''}
          <div class="cv-node-meta">${stats}</div>
        </div>
        <button type="button" class="cv-quick-btn" data-cv-enter-room="${esc(room.id)}" title="进入群聊" aria-label="进入 ${esc(room.name)}">${icon('arrow', 14)}</button>
      </div>${toggleDot}`;
    }

    if (node.kind === 'archive-bucket') {
      const parts = [];
      if (node.data.archivedRooms) parts.push(`${node.data.archivedRooms} 个归档群`);
      if (node.data.otherBots) parts.push(`${node.data.otherBots} 位其他 Bot`);
      if (node.data.deletedFiles) parts.push(`${node.data.deletedFiles} 份归档资料`);
      return `<div class="cv-node-body cv-bucket-node">
        <span class="cv-bucket-icon">${icon('archive', 18)}</span>
        <div class="cv-node-copy">
          <strong>归档与未分组</strong>
          <div class="cv-node-meta">${esc(parts.join(' · '))}</div>
        </div>
      </div>${toggleDot}`;
    }

    if (node.kind === 'bot') {
      const { bot, room, badge, execCount, liveCount, needsInput, memCount, fileCount } = node.data;
      const duty = cleanSummary(bot.public_duty || (bot.instructions || '').split('\n')[0], '团队成员');
      const bits = [];
      if (execCount) bits.push(liveCount ? `<em class="cv-stat-live">${liveCount} 运行中</em>` : `${execCount} 执行`);
      if (memCount) bits.push(`${memCount} 记忆`);
      if (fileCount) bits.push(`${fileCount} 资料`);
      return `<div class="cv-node-body cv-bot-node">
        <div class="cv-node-avatar">${avatar(bot.id, 42, '')}</div>
        <div class="cv-node-copy">
          <div class="cv-node-title-row">
            <strong>${esc(bot.name)}</strong>
            ${badge ? `<span class="cv-chip">${esc(badge)}</span>` : ''}
            ${bot.archived_at ? '<span class="cv-chip">归档</span>' : !bot.enabled ? '<span class="cv-chip is-warn">已暂停</span>' : ''}
            ${needsInput ? '<i class="cv-live-dot is-warn" title="等待审批或输入"></i>' : liveCount ? '<i class="cv-live-dot" title="正在执行"></i>' : ''}
          </div>
          <div class="cv-node-duty">${esc(duty)}</div>
          <div class="cv-node-meta">${bits.length ? bits.join(' · ') : '暂无执行或沉淀'}</div>
        </div>
        <button type="button" class="cv-quick-btn" data-cv-inspect-bot="${esc(bot.id)}" data-cv-room-id="${esc(room?.id || '')}" title="查看与编辑 Bot" aria-label="查看 ${esc(bot.name)}">${icon('info', 14)}</button>
      </div>${toggleDot}`;
    }

    if (node.kind === 'category') {
      const { title, count, liveCount, needsInput } = node.data;
      return `<div class="cv-node-body cv-cat-node">
        <span class="cv-cat-icon">${icon(node.data.icon, 16)}</span>
        <strong class="cv-cat-title">${esc(title)}</strong>
        ${needsInput ? '<i class="cv-live-dot is-warn"></i>' : liveCount ? '<i class="cv-live-dot"></i>' : ''}
        <span class="cv-cat-count">${count}</span>
      </div>${toggleDot}`;
    }

    if (node.kind === 'execution') {
      const { exec } = node.data;
      const isLive = ctx.LIVE_EXEC_STATUSES.has(exec.status);
      const needsInput = ['needs_input', 'awaiting_input'].includes(exec.status);
      const isFailed = exec.status === 'failed';
      const tone = needsInput ? 'warn' : isLive ? 'live' : isFailed ? 'error' : 'done';
      const statusText = needsInput ? '待输入' : isLive ? '进行中' : (labels[exec.status] || exec.status || '已结束');
      const summary = executionSummary(exec);
      const timeLabel = relativeTime(exec.updated_at || exec.created_at);
      return `<div class="cv-node-body cv-exec-node">
        <div class="cv-exec-top">
          <span class="cv-status-badge is-${tone}">${esc(statusText)}</span>
          <span class="cv-engine-tag">${esc(ctx.executionLabel(exec))}</span>
          ${timeLabel ? `<time class="cv-node-time">${esc(timeLabel)}</time>` : ''}
        </div>
        <p class="cv-exec-summary">${esc(summary)}</p>
      </div>`;
    }

    if (node.kind === 'memory') {
      const { memory } = node.data;
      const text = cleanSummary(memoryText(memory), '长期记忆条目');
      const scope = ctx.formatMemoryScope(memory.applies_to);
      return `<div class="cv-node-body cv-mem-node">
        <div class="cv-exec-top">
          <span class="cv-chip">${esc(scope)}</span>
        </div>
        <p class="cv-mem-summary">${esc(text)}</p>
      </div>`;
    }

    if (node.kind === 'file') {
      const { file } = node.data;
      return `<div class="cv-node-body cv-file-node">
        <span class="cv-cat-icon">${icon('knowledge', 16)}</span>
        <div class="cv-node-copy">
          <strong>${esc(file.name || file.path || '未命名资料')}</strong>
          <div class="cv-node-meta">修订 v${esc(file.revision ?? 1)}</div>
        </div>
      </div>`;
    }

    if (node.kind === 'more') {
      return `<div class="cv-node-body cv-more-node">
        <span>展开其余 ${node.data.remaining} 条…</span>
      </div>`;
    }

    return '';
  }

  function renderInspector() {
    if (!cv.inspector) return '';
    const { esc, icon, avatar, labels } = ctx;
    const ins = cv.inspector;

    let title = '', subtitle = '', body = '', footer = '';

    if (ins.kind === 'execution') {
      const base = ins.exec;
      const detail = cv.inspectorData || base;
      const ref = detail.execution_ref || base.execution_ref;
      const isLive = ctx.LIVE_EXEC_STATUSES.has(detail.status);
      const needsInput = ['needs_input', 'awaiting_input'].includes(detail.status);
      const error = ctx.executionError(detail);
      const summary = executionSummary(detail);
      title = ctx.executionLabel(detail);
      subtitle = [ins.room?.name, ins.bot?.name || (detail.bot_id ? ctx.nameOf(detail.bot_id) : '')].filter(Boolean).join(' · ');

      const rawOutput = [];
      if (detail.output != null && detail.output !== detail.output_page?.text) {
        rawOutput.push(typeof detail.output === 'string' ? detail.output : JSON.stringify(detail.output, null, 2));
      }
      for (const entry of (detail.messages || [])) {
        const msg = entry.message || entry;
        const content = msg.content ?? msg.text ?? msg.output ?? msg;
        const display = Array.isArray(content) ? content.map(p => p.text ?? JSON.stringify(p)).join('\n')
          : typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        rawOutput.push(`[${msg.role || entry.type || '输出'}]\n${display}`);
      }
      for (const page of (detail.output_pages || (detail.output_page ? [detail.output_page] : []))) {
        if (page?.text) rawOutput.push(page.text);
      }

      body = `<div class="cv-ins-summary-card">
        <div class="cv-ins-badges">
          <span class="cv-status-badge is-${needsInput ? 'warn' : isLive ? 'live' : detail.status === 'failed' ? 'error' : 'done'}">${esc(labels[detail.status] || detail.status || '未知')}</span>
          ${detail.model?.id ? `<span class="cv-chip">${esc(detail.model.id)}${detail.model.thinking_level ? ' · ' + esc(detail.model.thinking_level) : ''}</span>` : ''}
        </div>
        <p class="cv-ins-headline">${esc(summary)}</p>
        ${error ? `<p class="cv-ins-error">${esc(error)}</p>` : ''}
      </div>
      <dl class="cv-ins-facts">
        ${detail.updated_at || detail.created_at ? `<dt>更新时间</dt><dd>${esc(ctx.formatTime(detail.updated_at || detail.created_at, true))}</dd>` : ''}
        ${detail.origin_message_id ? `<dt>来源消息</dt><dd>${ctx.renderReference({ kind: 'event', id: detail.origin_message_id })}</dd>` : ''}
        ${detail.latest_call_id ? `<dt>最近调用</dt><dd>${ctx.renderReference({ kind: 'call', id: detail.latest_call_id })}</dd>` : ''}
      </dl>
      ${cv.inspectorLoading ? '<p class="subtle" style="font-size:var(--text-caption)">正在加载执行详情…</p>' : ''}
      ${rawOutput.length ? `<details class="cv-ins-debug"><summary>查看原始执行日志（排障）</summary><pre class="execution-output">${esc(rawOutput.join('\n\n'))}</pre></details>` : ''}`;

      footer = `<div class="cv-ins-footer">
        ${ins.room ? `<button type="button" class="secondary-button small-button" data-cv-enter-room="${esc(ins.room.id)}">进入群聊</button>` : ''}
        ${detail.can_stop ? `<button type="button" class="secondary-button small-button" data-cv-stop-exec="${esc(ref.id)}" data-cv-stop-kind="${esc(ref.kind)}">打断运行</button>` : ''}
        ${detail.status === 'suspended' ? `<button type="button" class="primary-button small-button" data-action="retry-suspended" data-conversation="${esc(ref.id)}">重试运行</button>` : ''}
      </div>`;
    } else if (ins.kind === 'memory') {
      const mem = ins.memory;
      title = '沉淀记忆';
      subtitle = [ins.room?.name, ins.bot?.name].filter(Boolean).join(' · ');
      const scope = ctx.formatMemoryScope(mem.applies_to);
      body = `<div class="cv-ins-summary-card">
        <div class="cv-ins-badges"><span class="cv-chip">${esc(scope)}</span></div>
        <p class="cv-ins-mem-full">${esc(memoryText(mem))}</p>
      </div>
      ${mem.sources?.length ? `<div class="cv-ins-sources"><small class="subtle">来源依据</small><div class="reference-list">${mem.sources.map(r => ctx.renderReference(r)).join('')}</div></div>` : ''}`;
      footer = ins.bot ? `<div class="cv-ins-footer"><button type="button" class="secondary-button small-button" data-action="edit-bot" data-id="${esc(ins.bot.id)}">编辑 Bot</button></div>` : '';
    } else if (ins.kind === 'file') {
      const base = ins.file;
      const item = cv.inspectorData || base;
      title = item.name || item.path || '资料';
      const latestRev = item.latest_revision ?? item.revision ?? 1;
      const isHistorical = latestRev && item.revision && item.revision !== latestRev;
      subtitle = `修订 v${item.revision ?? 1}${isHistorical ? `（历史版本 · 最新 v${latestRev}）` : ' · 当前正式版'}`;
      const revHistory = Array.isArray(item.revisions) && item.revisions.length > 1
        ? `<div class="cv-ins-revs">${item.revisions.map(rev => `<button type="button" class="${rev.revision === item.revision ? 'primary-button' : 'secondary-button'} small-button" data-cv-file-rev="${esc(rev.revision)}" data-cv-file-id="${esc(item.id)}">v${esc(rev.revision)}</button>`).join('')}</div>`
        : '';
      const rawDownload = item.id ? `/api/files/${encodeURIComponent(item.id)}/download` : '';
      const rawLink = typeof item.url === 'string' && (item.url === rawDownload || item.url.startsWith(rawDownload + '?revision=')) ? item.url : rawDownload;
      const link = rawLink ? (window.SummonHub?.apiPath?.(rawLink) || rawLink) : '';
      body = `${revHistory}
        ${cv.inspectorLoading ? '<p class="subtle" style="font-size:var(--text-caption)">正在读取资料内容…</p>' : ''}
        ${typeof item.content === 'string' ? `<pre class="cv-ins-doc">${esc(item.content)}</pre>` : item.content_status === 'unavailable' ? '<p class="subtle">文件内容不可用</p>' : ''}
        ${item.sources?.length ? `<div class="cv-ins-sources"><small class="subtle">修订来源</small><div class="reference-list">${item.sources.map(r => ctx.renderReference(r)).join('')}</div></div>` : ''}`;
      footer = `<div class="cv-ins-footer">
        ${link ? `<a class="secondary-button small-button" href="${esc(link)}" download>下载</a>` : ''}
        ${!isHistorical && item.path && typeof item.content === 'string' ? `<button type="button" class="primary-button small-button" data-action="edit-file" data-id="${esc(item.id)}">编辑资料</button>` : ''}
      </div>`;
    } else if (ins.kind === 'bot') {
      const bot = ctx.botById(ins.botId) || (ctx.state.archivedBots || []).find(b => b.id === ins.botId);
      if (!bot) return '';
      title = bot.name;
      const roleEntry = bot.role_id && (ctx.state.roles || []).find(r => r.id === bot.role_id);
      subtitle = roleEntry ? `${roleEntry.name} · r${bot.revision ?? 1}` : `r${bot.revision ?? 1}`;
      body = `<div class="cv-ins-bot-hero">${avatar(bot.id, 64, '')}<div><strong>${esc(bot.name)}</strong><small>${esc(ctx.formatBotModelSummary(bot))}</small></div></div>
        ${bot.public_duty ? `<p class="cv-ins-headline">${esc(bot.public_duty)}</p>` : ''}
        ${bot.instructions ? `<details class="cv-ins-debug" open><summary>人设与指令</summary><pre class="cv-ins-doc">${esc(bot.instructions)}</pre></details>` : ''}`;
      footer = `<div class="cv-ins-footer">
        ${!bot.archived_at ? `<button type="button" class="primary-button small-button" data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button>` : ''}
        ${ctx.renderBotControls(bot)}
      </div>`;
    }

    return `<aside class="cv-inspector" role="complementary" aria-label="详情抽屉">
      <header class="cv-inspector-head">
        <div class="cv-inspector-title"><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div>
        <button type="button" class="icon-button" data-cv-close-inspector aria-label="关闭详情">${icon('close', 18)}</button>
      </header>
      <div class="cv-inspector-body">${body}</div>
      ${footer}
    </aside>`;
  }

  function applyTransform(host) {
    const world = host?.querySelector('[data-cv-world]');
    const stage = host?.querySelector('[data-cv-stage]');
    if (world) {
      world.style.transform = `translate3d(${cv.x}px, ${cv.y}px, 0) scale(${cv.scale})`;
    }
    if (stage) {
      const gridStep = Math.max(14, 24 * cv.scale);
      stage.style.backgroundSize = `${gridStep}px ${gridStep}px`;
      stage.style.backgroundPosition = `${cv.x}px ${cv.y}px`;
    }
    const zoomLabel = host?.querySelector('[data-cv-zoom-label]');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(cv.scale * 100)}%`;
  }

  function animateCamera(host, targetX, targetY, targetScale = cv.scale, duration = 340) {
    cancelAnimationFrame(cv.animFrame);
    const startX = cv.x, startY = cv.y, startScale = cv.scale;
    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / duration);
      const ease = 1 - Math.pow(1 - p, 3);
      cv.x = startX + (targetX - startX) * ease;
      cv.y = startY + (targetY - startY) * ease;
      cv.scale = startScale + (targetScale - startScale) * ease;
      applyTransform(host);
      if (p < 1) cv.animFrame = requestAnimationFrame(tick);
    };
    cv.animFrame = requestAnimationFrame(tick);
  }

  function fitView(host, animate = true) {
    const stage = host?.querySelector('[data-cv-stage]');
    if (!stage || !cv.layoutNodes.size) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of cv.layoutNodes.values()) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    }
    const padX = 72, padTop = 92, padBottom = 88;
    const availW = Math.max(240, rect.width - padX * 2 - (cv.inspector ? 360 : 0));
    const availH = Math.max(220, rect.height - padTop - padBottom);
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const nextScale = Math.min(1, Math.max(MIN_SCALE, Math.min(availW / contentW, availH / contentH)));
    const nextX = padX + (availW - contentW * nextScale) / 2 - minX * nextScale;
    const nextY = padTop + (availH - contentH * nextScale) / 2 - minY * nextScale;
    if (animate) animateCamera(host, nextX, nextY, nextScale);
    else { cv.x = nextX; cv.y = nextY; cv.scale = nextScale; applyTransform(host); }
  }

  function focusSubtree(host, nodeId) {
    const stage = host?.querySelector('[data-cv-stage]');
    const root = cv.layoutNodes.get(nodeId);
    if (!stage || !root) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let minX = root.x, minY = root.y, maxX = root.x + root.w, maxY = root.y + root.h;
    const walk = n => {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
      if (n.expanded) for (const c of n.children) walk(c);
    };
    walk(root);

    const viewW = rect.width - (cv.inspector ? 360 : 0);
    const viewH = rect.height;
    const padL = 56, padR = 64, padT = 84, padB = 80;
    const leftScreen = minX * cv.scale + cv.x;
    const rightScreen = maxX * cv.scale + cv.x;
    const topScreen = minY * cv.scale + cv.y;
    const bottomScreen = maxY * cv.scale + cv.y;

    let nextX = cv.x, nextY = cv.y;
    if (rightScreen > viewW - padR) {
      nextX -= (rightScreen - (viewW - padR));
      if (minX * cv.scale + nextX < padL) nextX = padL - minX * cv.scale;
    } else if (leftScreen < padL) {
      nextX += (padL - leftScreen);
    }
    const centerY = (minY + maxY) / 2;
    if (topScreen < padT || bottomScreen > viewH - padB) {
      nextY = viewH / 2 - centerY * cv.scale;
    }
    if (Math.abs(nextX - cv.x) > 4 || Math.abs(nextY - cv.y) > 4) {
      animateCamera(host, nextX, nextY, cv.scale, 340);
    }
  }

  function patchCanvasDom(host) {
    if (!host || !ctx) return;
    const roots = buildTree();
    const { nodes, edges } = computeLayout(roots);
    cv.layoutNodes = nodes;
    cv.layoutEdges = edges;

    const nodesLayer = host.querySelector('[data-cv-nodes]');
    const edgesLayer = host.querySelector('[data-cv-edges]');
    const inspectorSlot = host.querySelector('[data-cv-inspector-slot]');
    const emptySlot = host.querySelector('[data-cv-empty]');
    const detachedBanner = host.querySelector('[data-cv-detached]');

    if (emptySlot) emptySlot.hidden = nodes.size > 0;

    // Diff nodes in place so CSS transforms animate smoothly on expand/collapse
    if (nodesLayer) {
      const existing = new Map([...nodesLayer.children].map(el => [el.dataset.nodeId, el]));
      for (const [id, el] of existing) {
        if (!nodes.has(id)) el.remove();
      }
      for (const node of nodes.values()) {
        let el = existing.get(node.id);
        const isSelected = cv.selectedNodeId === node.id;
        const className = `cv-node cv-kind-${node.kind}${node.expanded ? ' is-expanded' : ''}${node.live ? ' is-live' : ''}${isSelected ? ' is-selected' : ''}`;
        const inner = renderNodeInner(node);
        if (!el) {
          el = document.createElement('div');
          el.dataset.nodeId = node.id;
          el.dataset.nodeKind = node.kind;
          el.setAttribute('role', 'button');
          el.setAttribute('tabindex', '0');
          el.className = className + ' is-entering';
          el.style.width = `${node.w}px`;
          el.style.minHeight = `${node.h}px`;
          el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
          el.innerHTML = inner;
          nodesLayer.append(el);
          requestAnimationFrame(() => el.classList.remove('is-entering'));
        } else {
          if (el.className !== className) el.className = className;
          el.style.width = `${node.w}px`;
          el.style.minHeight = `${node.h}px`;
          el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
          if (el._lastHtml !== inner) {
            el.innerHTML = inner;
            el._lastHtml = inner;
          }
        }
        el._lastHtml = inner;
      }
      window.SummonAvatars?.hydrate?.(nodesLayer);
    }

    // Update SVG edges cleanly
    if (edgesLayer) {
      let maxX = 1200, maxY = 900;
      for (const n of nodes.values()) {
        maxX = Math.max(maxX, n.x + n.w + 200);
        maxY = Math.max(maxY, n.y + n.h + 200);
      }
      edgesLayer.setAttribute('width', String(maxX));
      edgesLayer.setAttribute('height', String(maxY));
      edgesLayer.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);

      const existing = new Map([...edgesLayer.children].map(el => [el.dataset.edgeId, el]));
      const nextIds = new Set(edges.map(e => e.id));
      for (const [id, el] of existing) if (!nextIds.has(id)) el.remove();
      for (const edge of edges) {
        let path = existing.get(edge.id);
        const d = bezierPath(edge);
        const cls = `cv-edge${edge.live ? ' is-live' : ''}`;
        if (!path) {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.dataset.edgeId = edge.id;
          path.setAttribute('class', cls);
          path.setAttribute('d', d);
          edgesLayer.append(path);
        } else {
          if (path.getAttribute('class') !== cls) path.setAttribute('class', cls);
          if (path.getAttribute('d') !== d) path.setAttribute('d', d);
        }
      }
    }

    // Detached background processes warning pill (only when non-empty)
    if (detachedBanner) {
      const detached = ctx.state.detached || [];
      if (!detached.length) {
        detachedBanner.innerHTML = '';
        detachedBanner.hidden = true;
      } else {
        detachedBanner.hidden = false;
        detachedBanner.innerHTML = `<button type="button" class="cv-detached-pill" data-cv-toggle-detached>
            <i class="cv-live-dot is-warn"></i><span>${detached.length} 个后台脱钩进程</span>
          </button>
          ${cv.detachedOpen ? `<div class="cv-detached-popover">${detached.map(item => `<div class="cv-detached-row">
            <div><strong>${ctx.esc(item.connection_name || item.connection_id)}</strong><small>${item.alive ? '进程仍在运行' : '已退出'}${item.child_pid || item.runner_pid ? ` · PID ${ctx.esc(item.child_pid || item.runner_pid)}` : ''}</small></div>
            <div class="cv-detached-actions">${item.alive ? `<button type="button" class="secondary-button small-button" data-action="kill-detached" data-id="${ctx.esc(item.id)}">强杀</button>` : ''}<button type="button" class="text-button" data-action="dismiss-detached" data-id="${ctx.esc(item.id)}">清理</button></div>
          </div>`).join('')}</div>` : ''}`;
      }
    }

    // Inspector drawer
    if (inspectorSlot) {
      inspectorSlot.innerHTML = renderInspector();
      window.SummonAvatars?.hydrate?.(inspectorSlot);
    }

    if (!cv.initialized && nodes.size) {
      cv.initialized = true;
      requestAnimationFrame(() => fitView(host, false));
    } else {
      applyTransform(host);
    }
  }

  async function openInspector(nextInspector, host) {
    cv.inspector = nextInspector;
    cv.inspectorData = null;
    cv.inspectorLoading = false;
    if (nextInspector?.kind === 'execution') {
      cv.inspectorLoading = true;
      patchCanvasDom(host);
      try {
        const ref = nextInspector.exec.execution_ref;
        const detail = await ctx.api(ctx.executionPath(ref));
        if (cv.inspector === nextInspector) cv.inspectorData = detail;
      } catch { /* fallback to list summary */ }
      finally {
        if (cv.inspector === nextInspector) { cv.inspectorLoading = false; patchCanvasDom(host); }
      }
      return;
    }
    if (nextInspector?.kind === 'file') {
      cv.inspectorLoading = true;
      patchCanvasDom(host);
      try {
        const qs = nextInspector.revision ? `?revision=${encodeURIComponent(nextInspector.revision)}` : '';
        const detail = await ctx.api(`/api/files/${encodeURIComponent(nextInspector.file.id)}${qs}`);
        if (cv.inspector === nextInspector) cv.inspectorData = detail;
      } catch { /* fallback */ }
      finally {
        if (cv.inspector === nextInspector) { cv.inspectorLoading = false; patchCanvasDom(host); }
      }
      return;
    }
    patchCanvasDom(host);
  }

  function handleNodeClick(nodeId, host) {
    const node = cv.layoutNodes.get(nodeId);
    if (!node) return;
    cv.selectedNodeId = nodeId;

    if (node.kind === 'more') {
      cv.showAll.add(node.data.targetId);
      patchCanvasDom(host);
      return;
    }

    if (node.kind === 'execution') {
      void openInspector({ kind: 'execution', exec: node.data.exec, room: node.data.room, bot: node.data.bot }, host);
      return;
    }
    if (node.kind === 'memory') {
      void openInspector({ kind: 'memory', memory: node.data.memory, room: node.data.room, bot: node.data.bot }, host);
      return;
    }
    if (node.kind === 'file') {
      void openInspector({ kind: 'file', file: node.data.file, room: node.data.room, bot: node.data.bot }, host);
      return;
    }

    // Expandable container node (room, archive-bucket, bot, category)
    if (node.children.length) {
      if (cv.expanded.has(nodeId)) {
        cv.expanded.delete(nodeId);
      } else {
        cv.expanded.add(nodeId);
        // Smart 1-click unfold: if a Bot has only 1 category with <= 6 items, unfold it together.
        if (node.kind === 'bot' && node.children.length === 1 && node.children[0].children.length <= 6) {
          cv.expanded.add(node.children[0].id);
        }
      }
      patchCanvasDom(host);
      if (cv.expanded.has(nodeId)) focusSubtree(host, nodeId);
    } else if (node.kind === 'bot') {
      void openInspector({ kind: 'bot', botId: node.data.bot.id, room: node.data.room }, host);
    } else {
      patchCanvasDom(host);
    }
  }

  function bindHostEvents(host) {
    if (host._cvBound) return;
    host._cvBound = true;
    const stage = host.querySelector('[data-cv-stage]');

    stage.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target.closest('.cv-node, .cv-controls, .cv-inspector, .cv-detached-slot')) return;
      cancelAnimationFrame(cv.animFrame);
      cv.dragging = true;
      cv.dragMoved = false;
      cv.dragStartX = event.clientX;
      cv.dragStartY = event.clientY;
      cv.panStartX = cv.x;
      cv.panStartY = cv.y;
      stage.classList.add('is-dragging');
      stage.setPointerCapture?.(event.pointerId);
    });

    stage.addEventListener('pointermove', event => {
      if (!cv.dragging) return;
      const dx = event.clientX - cv.dragStartX;
      const dy = event.clientY - cv.dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cv.dragMoved = true;
      cv.x = cv.panStartX + dx;
      cv.y = cv.panStartY + dy;
      applyTransform(host);
    });

    const endDrag = event => {
      if (!cv.dragging) return;
      cv.dragging = false;
      stage.classList.remove('is-dragging');
      try { stage.releasePointerCapture?.(event.pointerId); } catch {}
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    stage.addEventListener('wheel', event => {
      if (event.target.closest('.cv-inspector, .cv-detached-popover')) return;
      event.preventDefault();
      cancelAnimationFrame(cv.animFrame);
      const isPinchOrMouseWheel = event.ctrlKey || event.metaKey || (event.deltaX === 0 && Math.abs(event.deltaY) >= 40 && !event.shiftKey);
      if (isPinchOrMouseWheel) {
        const rect = stage.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.008 : 0.0016));
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cv.scale * factor));
        const ratio = nextScale / cv.scale;
        cv.x = cx - (cx - cv.x) * ratio;
        cv.y = cy - (cy - cv.y) * ratio;
        cv.scale = nextScale;
      } else {
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
        cv.x -= dx;
        cv.y -= dy;
      }
      applyTransform(host);
    }, { passive: false });

    host.addEventListener('click', async event => {
      const enterRoom = event.target.closest('[data-cv-enter-room]');
      if (enterRoom) {
        event.stopPropagation();
        return ctx.selectRoom(enterRoom.dataset.cvEnterRoom);
      }
      const inspectBot = event.target.closest('[data-cv-inspect-bot]');
      if (inspectBot) {
        event.stopPropagation();
        const r = inspectBot.dataset.cvRoomId ? ctx.roomById(inspectBot.dataset.cvRoomId) : null;
        return void openInspector({ kind: 'bot', botId: inspectBot.dataset.cvInspectBot, room: r }, host);
      }
      const closeIns = event.target.closest('[data-cv-close-inspector]');
      if (closeIns) {
        cv.inspector = null; cv.inspectorData = null;
        patchCanvasDom(host);
        return;
      }
      const stopBtn = event.target.closest('[data-cv-stop-exec]');
      if (stopBtn) {
        stopBtn.disabled = true;
        try {
          await ctx.api('/api/executions/stop', 'POST', { targets: [{ kind: stopBtn.dataset.cvStopKind, id: stopBtn.dataset.cvStopExec }] });
          ctx.toast('已发送打断请求');
          await ctx.refresh();
          if (cv.inspector?.kind === 'execution') void openInspector(cv.inspector, host);
        } catch (err) { ctx.toast(err.message, true); }
        return;
      }
      const revBtn = event.target.closest('[data-cv-file-rev]');
      if (revBtn && cv.inspector?.kind === 'file') {
        void openInspector({ ...cv.inspector, revision: Number(revBtn.dataset.cvFileRev) }, host);
        return;
      }
      const toggleDetached = event.target.closest('[data-cv-toggle-detached]');
      if (toggleDetached) {
        cv.detachedOpen = !cv.detachedOpen;
        patchCanvasDom(host);
        return;
      }
      const ctrl = event.target.closest('[data-cv-ctrl]');
      if (ctrl) {
        const op = ctrl.dataset.cvCtrl;
        const rect = stage.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        if (op === 'zoom-in' || op === 'zoom-out' || op === 'zoom-reset') {
          const target = op === 'zoom-reset' ? 1 : Math.min(MAX_SCALE, Math.max(MIN_SCALE, cv.scale * (op === 'zoom-in' ? 1.22 : 1 / 1.22)));
          const ratio = target / cv.scale;
          animateCamera(host, cx - (cx - cv.x) * ratio, cy - (cy - cv.y) * ratio, target, 240);
        } else if (op === 'fit') {
          fitView(host, true);
        } else if (op === 'collapse-all') {
          cv.expanded.clear();
          cv.inspector = null;
          cv.selectedNodeId = null;
          patchCanvasDom(host);
          fitView(host, true);
        }
        return;
      }

      const nodeEl = event.target.closest('.cv-node');
      if (nodeEl) {
        handleNodeClick(nodeEl.dataset.nodeId, host);
        return;
      }

      // Click empty canvas closes inspector/detached popover if not a drag
      if (!cv.dragMoved && event.target.closest('[data-cv-stage]') && !event.target.closest('.cv-inspector, .cv-controls, .cv-detached-slot')) {
        let changed = false;
        if (cv.inspector) { cv.inspector = null; cv.inspectorData = null; changed = true; }
        if (cv.detachedOpen) { cv.detachedOpen = false; changed = true; }
        if (changed) patchCanvasDom(host);
      }
    });
  }

  function renderShell() {
    const { icon } = ctx;
    return `<div class="canvas-overview-page" data-cv-host>
      ${globalThis.SummonPageNav?.('overview') || ''}
      <div class="cv-detached-slot" data-cv-detached hidden></div>
      <div class="cv-stage" data-cv-stage>
        <div class="cv-world" data-cv-world>
          <svg class="cv-edges" data-cv-edges aria-hidden="true"></svg>
          <div class="cv-nodes" data-cv-nodes></div>
        </div>
        <div class="cv-empty" data-cv-empty hidden>
          <p>还没有群聊，点击左上角新建群聊开始协作</p>
        </div>
      </div>
      <div class="cv-controls" role="toolbar" aria-label="画布控制">
        <button type="button" data-cv-ctrl="zoom-out" title="缩小" aria-label="缩小">−</button>
        <button type="button" class="cv-zoom-readout" data-cv-ctrl="zoom-reset" data-cv-zoom-label title="重置缩放">100%</button>
        <button type="button" data-cv-ctrl="zoom-in" title="放大" aria-label="放大">+</button>
        <span class="cv-ctrl-sep" aria-hidden="true"></span>
        <button type="button" data-cv-ctrl="fit" title="适应画面">适应</button>
        <button type="button" data-cv-ctrl="collapse-all" title="收起所有展开的层级">收起</button>
        <span class="cv-ctrl-sep" aria-hidden="true"></span>
        <button type="button" data-action="new-bot" title="创建独立 Bot">${icon('plus', 14)}<span>Bot</span></button>
      </div>
      <div class="cv-inspector-slot" data-cv-inspector-slot></div>
    </div>`;
  }

  function mount(mainEl) {
    const host = mainEl?.querySelector('[data-cv-host]');
    if (!host || !ctx) return;
    bindHostEvents(host);
    patchCanvasDom(host);
  }

  function focusRoom(roomId) {
    if (!roomId) return;
    cv.expanded.add(`room:${roomId}`);
    cv.selectedNodeId = `room:${roomId}`;
    const host = document.querySelector('[data-cv-host]');
    if (host) {
      patchCanvasDom(host);
      focusSubtree(host, `room:${roomId}`);
    }
  }

  function focusExecution(ref) {
    if (!ref || !ctx) return;
    const match = (ctx.state.executions || []).find(item => ctx.sameRef(item.execution_ref, ref));
    const roomId = match?.space?.kind === 'room' ? match.space.id : null;
    const botId = match?.execution_actor?.id || match?.bot_id || null;
    if (roomId) cv.expanded.add(`room:${roomId}`);
    if (roomId && botId) {
      cv.expanded.add(`bot:${roomId}:${botId}`);
      cv.expanded.add(`cat:execs:${roomId}:${botId}`);
      cv.selectedNodeId = `exec:${roomId}:${botId}:${ctx.refKey(ref)}`;
    }
    const host = document.querySelector('[data-cv-host]');
    const room = roomId ? ctx.roomById(roomId) : null;
    const bot = botId ? ctx.botById(botId) : null;
    const execObj = match || { execution_ref: ref, status: 'unknown' };
    if (host) {
      patchCanvasDom(host);
      if (cv.selectedNodeId) focusSubtree(host, cv.selectedNodeId);
      void openInspector({ kind: 'execution', exec: execObj, room, bot }, host);
    } else {
      cv.inspector = { kind: 'execution', exec: execObj, room, bot };
    }
  }

  function focusFile(fileId) {
    if (!fileId || !ctx) return;
    const file = (ctx.state.files || []).find(f => f.id === fileId) || { id: fileId, name: '资料' };
    const roomId = file.space?.kind === 'room' ? file.space.id : null;
    const botId = file.space?.kind === 'bot' ? file.space.id : null;
    if (roomId) {
      cv.expanded.add(`room:${roomId}`);
      cv.expanded.add(`cat:rfiles:${roomId}`);
      cv.selectedNodeId = `file:cat:rfiles:${roomId}:${fileId}`;
    }
    const host = document.querySelector('[data-cv-host]');
    const room = roomId ? ctx.roomById(roomId) : null;
    const bot = botId ? ctx.botById(botId) : null;
    if (host) {
      patchCanvasDom(host);
      if (cv.selectedNodeId) focusSubtree(host, cv.selectedNodeId);
      void openInspector({ kind: 'file', file, room, bot }, host);
    } else {
      cv.inspector = { kind: 'file', file, room, bot };
    }
  }

  function closeInspectorIfOpen() {
    if (!cv.inspector) return false;
    cv.inspector = null;
    cv.inspectorData = null;
    const host = document.querySelector('[data-cv-host]');
    if (host) patchCanvasDom(host);
    return true;
  }

  function resetInit() {
    cv.initialized = false;
  }

  return {
    setContext,
    renderShell,
    mount,
    focusRoom,
    focusExecution,
    focusFile,
    closeInspectorIfOpen,
    resetInit,
  };
})();
