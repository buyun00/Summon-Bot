'use strict';

globalThis.RelayUsage = (() => {
  const view = { period: 'today', dimension: 'bots', sort: 'totalTokens', selected: null, offset: 0, data: new Map(), errors: new Map(), loading: new Map(), expanded: new Set() };
  document.addEventListener('toggle', event => {
    const row = event.target;
    if (!row.matches?.('.usage-request[data-id]') || !row.isConnected) return;
    if (row.open) view.expanded.add(row.dataset.id); else view.expanded.delete(row.dataset.id);
  }, true);
  const periods = { today: '今天', yesterday: '昨天', '7d': '近 7 天', all: '累计' };
  const purposes = { chat: '聊天', work: '工作执行', routing: '群聊路由', compress: '上下文压缩', compact: '上下文压缩', organize: '记忆整理', assemble: '上下文组装', other: '其他调用' };
  const statuses = { succeeded: '完成', failed: '失败', cancelled: '取消', pending: '调用中', unknown: '结果未知' };
  const number = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
  const money = totals => !totals?.pricedCalls ? '—' : `$${totals.costMin.toFixed(4)}–${totals.costMax.toFixed(4)}`;
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const keyFor = (selected = view.selected, offset = view.offset) => `${view.period}:${selected?.kind || 'all'}:${selected?.id || ''}:${offset}`;
  async function fetchPage(api, selected, offset) {
    const key = keyFor(selected, offset);
    if (view.loading.has(key)) return view.loading.get(key);
    const params = new URLSearchParams({ period: view.period, offset: String(offset), limit: '25' });
    if (selected) params.set(selected.kind === 'bot' ? 'botId' : 'roomId', selected.id);
    const pending = api(`/api/usage?${params}`).then(data => { view.data.set(key, data); view.errors.delete(key); })
      .catch(error => view.errors.set(key, error.message)).finally(() => view.loading.delete(key));
    view.loading.set(key, pending); return pending;
  }
  async function load(api) {
    await Promise.all([fetchPage(api, null, 0), ...(view.selected || view.offset ? [fetchPage(api, view.selected, view.offset)] : [])]);
  }
  async function act(action, element, api, render) {
    if (action === 'usage-period') { view.period = element.dataset.id; view.offset = 0; }
    if (action === 'usage-dimension') { view.dimension = element.dataset.id; view.selected = null; view.offset = 0; }
    if (action === 'usage-sort') { view.sort = element.dataset.id; return render(); }
    if (action === 'usage-select') { view.selected = { kind: element.dataset.kind, id: element.dataset.id, name: element.dataset.name }; view.offset = 0; }
    if (action === 'usage-clear') { view.selected = null; view.offset = 0; }
    if (action === 'usage-page') view.offset = Math.max(0, view.offset + Number(element.dataset.step) * 25);
    const pending = load(api); render(); await pending; render();
  }
  function render({ esc, icon }) {
    const totalKey = keyFor(null, 0), selectedKey = keyFor(), overview = view.data.get(totalKey), data = view.data.get(selectedKey);
    const error = view.errors.get(selectedKey) || view.errors.get(totalKey);
    const button = (action, id, text, active) => `<button type="button" data-action="${action}" data-id="${esc(id)}" class="${active ? 'active' : ''}" aria-pressed="${active}">${text}</button>`;
    const controls = `<div class="usage-periods" aria-label="统计范围">${Object.entries(periods).map(([id, title]) => button('usage-period', id, title, view.period === id)).join('')}</div><button class="secondary-button" data-action="usage-refresh" ${view.loading.size ? 'disabled' : ''}>${icon('refresh', 16)}刷新</button>`;
    const metric = (title, value, hint = '') => `<div class="usage-metric"><span>${title}</span><strong>${value}</strong>${hint ? `<small>${hint}</small>` : ''}</div>`;
    const metrics = (totals, compact = false) => `<div class="usage-metrics ${compact ? 'compact' : ''}">${metric('已记录输入 Token', number(totals.inputTokens), `平均每次 ${number(totals.averageInputTokens)}`)}${metric('已记录输出 Token', number(totals.outputTokens), `推理 ${totals.reasoningReportedCalls ? number(totals.reasoningTokens) : '未返回明细'} · 包含在输出内`)}${metric('已记录输入缓存命中', number(totals.cacheHitTokens), `未命中 ${number(totals.cacheMissTokens)}`)}${metric('留存明细缓存命中率', percent(totals.cacheHitRate), `缓存字段覆盖 ${percent(totals.cacheCoverage)} · 仅限已留存明细`)}${metric('已记录 API 调用', number(totals.calls), `失败 ${number(totals.failed)} · 取消 ${number(totals.cancelled)} · 未知 ${number(totals.unknown)}`)}${metric('已记录参考费用 · USD', money(totals), `${number(totals.pricedCalls)} 次有费用依据`)}</div>`;
    const summary = overview ? metrics(overview.totals) : '<div class="usage-placeholder">正在读取 Token 统计…</div>';
    const billing = (overview?.providerReports || []).map(report => `<section class="usage-billing"><div class="usage-section-heading"><div><h2>${esc(report.day)} · 供应商用量对照</h2><p>DeepSeek · API Key：${esc(report.billingLabel)} · 来源：用户提供的截图（人工记录，非实时同步）</p></div></div><div class="usage-table-scroll"><table class="usage-table"><thead><tr><th>统计来源</th><th>API 请求</th><th>Token</th><th>费用</th></tr></thead><tbody><tr><th>DeepSeek 截图总量</th><td>${number(report.calls)}</td><td>${number(report.totalTokens)}</td><td>¥${report.amount.toFixed(2)} CNY</td></tr><tr><th>本机可追溯明细</th><td>${number(report.localCalls)}</td><td>${number(report.localTokens)}</td><td>${money({pricedCalls:report.localPricedCalls,costMin:report.localCostMin,costMax:report.localCostMax})} USD 参考</td></tr><tr class="usage-billing-gap"><th>${report.differenceCalls < 0 || report.differenceTokens < 0 ? '差额（统计范围待核对）' : '尚无本机明细的差额'}</th><td>${number(report.differenceCalls)}</td><td>${number(report.differenceTokens)}</td><td>无法拆分</td></tr></tbody></table></div><p class="usage-billing-note">本机明细覆盖截图 Token 总量的 ${percent(report.tokenCoverage)}。缺失部分未分摊到任何 Bot 或会话；无法据此计算该日整体缓存命中率。两处费用币种和口径不同，不直接比较。</p></section>`).join('');
    const coverage = overview?.coverage?.includesUntrackedHistory ? `<p class="usage-notice">本范围包含采集启用前的数据。全局独立记账从 ${time(overview.coverage.collectionStartedAt)} 起启用；此前仅回填仍保留的历史明细，已清理 Bot、会话等缺失记录未计入排行和命中率。</p>` : '';
    const ranking = overview ? (view.dimension === 'bots' ? overview.bots : overview.rooms.filter(room => view.dimension === 'dm' ? room.kind === 'dm' : room.kind !== 'dm' && room.kind !== 'unassigned'))
      .slice().sort((a, b) => (b[view.sort] || 0) - (a[view.sort] || 0)) : [];
    const table = ranking.length ? `<div class="usage-table-scroll"><table class="usage-table"><thead><tr><th>${view.dimension === 'bots' ? 'Bot' : '会话'}</th><th>总 Token</th><th>输入 / 输出</th><th>缓存命中率</th><th>调用</th><th>参考费用</th></tr></thead><tbody>${ranking.map((row, index) => `<tr class="${view.selected?.id === row.id ? 'selected' : ''}"><th><button data-action="usage-select" data-id="${esc(row.id)}" data-name="${esc(row.name)}" data-kind="${view.dimension === 'bots' ? 'bot' : 'room'}"><span class="usage-rank">${index + 1}</span>${esc(row.name)}</button></th><td>${number(row.totalTokens)}</td><td>${number(row.inputTokens)} / ${number(row.outputTokens)}</td><td>${percent(row.cacheHitRate)}</td><td>${number(row.calls)}</td><td>${money(row)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="usage-placeholder">这个范围内还没有${view.dimension === 'bots' ? ' Bot' : view.dimension === 'dm' ? '单聊' : '群聊'}用量。</p>`;
    const group = (title, rows, label) => `<section class="usage-breakdown"><h3>${title}</h3>${rows?.length ? rows.map(row => `<div class="usage-breakdown-row"><div><strong>${esc(label(row))}</strong><small>${number(row.calls)} 次 · 输入 ${number(row.inputTokens)} / 输出 ${number(row.outputTokens)} · 命中 ${percent(row.cacheHitRate)}</small></div><span>${number(row.totalTokens)}<small>${money(row)}</small></span></div>`).join('') : '<p class="subtle">暂无记录</p>'}</section>`;
    const unknown = overview?.rooms.find(room => !room.id);
    const detail = data ? `<section class="usage-detail"><div class="usage-section-heading"><div><h2>${esc(view.selected?.name || '全部已记录用量明细')}</h2><p>${esc(periods[view.period])} · 北京时间${data.firstRecordAt ? ` · 最早保留记录 ${time(data.firstRecordAt)}` : ''}</p></div>${view.selected ? '<button class="text-button" data-action="usage-clear">查看全部</button>' : ''}</div>${view.selected ? metrics(data.totals, true) : ''}
      ${data.totals.unreportedCalls ? `<p class="usage-notice">${number(data.totals.unreportedCalls)} 次调用尚未取得完整 Token 回执；已返回的部分计入统计，缺失部分不按零消耗计算。</p>` : ''}
      <div class="usage-breakdowns">${group('消耗来源', data.purposes, row => purposes[row.key] || row.key)}${group('模型', data.models, row => row.key)}${view.selected?.kind === 'room' ? group('会话内 Bot', data.bots.filter(row => row.calls), row => row.name) : ''}${view.selected?.kind === 'bot' ? group('Bot 的会话', data.rooms, row => row.name) : ''}${data.days.length > 1 ? group('每日用量', data.days, row => row.key) : ''}</div>
      <div class="usage-section-heading"><h3>逐次调用</h3><span>${number(data.offset + (data.requests.length ? 1 : 0))}–${number(data.offset + data.requests.length)} / ${number(data.totals.calls)}</span></div>
      <div class="usage-requests">${data.requests.map(request => `<details class="usage-request" data-id="${esc(`${request.botId}:${request.id}`)}" ${view.expanded.has(`${request.botId}:${request.id}`) ? 'open' : ''}><summary><span><strong>${esc(request.botName)} · ${esc(purposes[request.purpose] || request.purpose)}</strong><small>${time(request.startedAt)} · ${esc(statuses[request.status] || request.status)}${request.historical ? ' · 历史回填' : ''}</small></span><span>${number(request.totalTokens)}<small>命中 ${percent(request.inputTokens && request.cacheHitTokens !== null ? request.cacheHitTokens / request.inputTokens : null)}</small></span></summary><dl>
      <dt>会话</dt><dd>${esc(overview.rooms.find(room => room.id === request.roomId)?.name || '未归属会话')}</dd><dt>模型</dt><dd>${esc(request.model)}</dd>
      <dt>输入 / 输出</dt><dd>${number(request.inputTokens)} / ${number(request.outputTokens)}</dd><dt>缓存命中 / 未命中</dt><dd>${number(request.cacheHitTokens)} / ${number(request.cacheMissTokens)}</dd><dt>推理 Token</dt><dd>${number(request.reasoningTokens)}（包含在输出内）</dd>
      <dt>参考费用 · USD</dt><dd>${request.cost ? `$${request.cost.min.toFixed(6)}–${request.cost.max.toFixed(6)}` : '—'}</dd><dt>耗时</dt><dd>${request.latencyMs === null || request.latencyMs === undefined ? '—' : `${(request.latencyMs / 1000).toFixed(1)} 秒`}</dd><dt>结束原因</dt><dd>${esc(request.finishReason || '—')}</dd><dt>消息 / 工具定义数</dt><dd>${number(request.messageCount)} / ${number(request.toolCount)}</dd><dt>系统提示 / 工具定义字符</dt><dd>${number(request.systemChars)} / ${number(request.toolDefinitionChars)}</dd>
      ${[['工作 ID', request.workId], ['任务 ID', request.taskId], ['会话 ID', request.sessionId], ['响应 ID', request.responseId], ['错误', request.error]].filter(([, value]) => value).map(([title, value]) => `<dt>${title}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details>`).join('') || '<p class="usage-placeholder">还没有调用记录。</p>'}</div>
      <div class="usage-pagination"><button class="secondary-button" data-action="usage-page" data-step="-1" ${data.offset ? '' : 'disabled'}>上一页</button><button class="secondary-button" data-action="usage-page" data-step="1" ${data.hasMore ? '' : 'disabled'}>下一页</button></div></section>` : `<div class="usage-placeholder">${error ? '用量读取失败，请刷新。' : '正在读取调用明细…'}</div>`;
    return `<div class="page usage-page"><header class="usage-header"><div><button class="text-button" data-action="navigate" data-view="chat">${icon('back', 17)}返回聊天</button><p class="usage-eyebrow">设置 / 用量分析</p><h1>Token 统计</h1><p>统一查看供应商总量与可归属到 Bot、单聊和群聊的明细。</p></div><div class="usage-controls">${controls}</div></header>${error ? `<p class="usage-notice" role="alert">${esc(error)}</p>` : ''}${billing}${coverage}<div class="usage-section-heading"><h2>本机已记录用量</h2>${overview ? `<span>${number(overview.totals.totalTokens)} Token · ${number(overview.totals.calls)} 次调用</span>` : ''}</div>${summary}
      <section class="usage-ranking"><div class="usage-section-heading"><div class="usage-dimensions" aria-label="统计维度">${[['bots', 'Bot'], ['dm', '单聊'], ['group', '群聊']].map(([id, title]) => button('usage-dimension', id, title, view.dimension === id)).join('')}</div><div class="usage-sorts" aria-label="排行依据">${[['totalTokens', 'Token'], ['costMax', '费用'], ['cacheMissTokens', '未命中'], ['calls', '调用次数']].map(([id, title]) => button('usage-sort', id, title, view.sort === id)).join('')}</div></div>${table}
      ${unknown?.calls ? `<p class="usage-unassigned">未归属会话：${number(unknown.totalTokens)} Token · ${number(unknown.calls)} 次<button class="text-button" data-action="usage-select" data-kind="room" data-id="" data-name="未归属会话">查看明细</button></p>` : ''}</section>${detail}
      <footer class="usage-footnote"><p>输入 = 缓存命中 + 未命中；命中率按已返回缓存明细的输入 Token 加权。输出另计，DeepSeek 不提供“输出缓存命中”指标；推理 Token 已包含在输出内。</p><p>统计包括聊天、工作、路由及压缩 / 整理 / 组装。历史仅回填原有 Token 记录，缺失回执无法追溯，不能代替完整账单。费用为美元低峰至高峰参考区间，单价核对于 2026-11-03。<a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noopener noreferrer">官方价格</a> · <a href="https://api-docs.deepseek.com/guides/kv_cache/" target="_blank" rel="noopener noreferrer">缓存规则</a></p></footer></div>`;
  }
  return { render, load, act };
})();
