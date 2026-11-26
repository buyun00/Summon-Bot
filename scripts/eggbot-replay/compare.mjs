const readOnly = new Set(['find', 'read']);
const op = call => call.tool === 'find' ? 'find.' + call.args.kind :
  call.tool === 'configure_room' && call.args.add_members?.length ? 'configure_room.add_members' : call.tool;

// Check objective differences. The report pairs all remaining semantic criteria
// with receipts, without treating a nonempty response as a correct answer.
export function compare(report, gold) {
  const realTarget = report.aliases[gold.target_bot_id];
  const added = report.addedMembers.map(m => m.id);
  const created = report.newBots;
  const sent = report.messages.length > 0;
  const wrote = report.files.filter(file => file.space?.kind === 'room');
  const wrongRoute = report.decisions.some(d => !gold.accepted_fast_routes.includes(d.route));
  function check(outcome) {
    const problems = [];
    const need = (condition, reason) => { if (!condition) problems.push(reason); };
    need(!wrongRoute, '快读决策不符合本例期望');
    if (outcome.required.includes('existing_match_identified') && outcome.kind === 'P')
      need(report.calls.some(c => c.tool === 'find' && c.args.kind === 'bot' && c.state === 'completed'), '缺少可用成员查询');
    if (outcome.forbidden.includes('new_bot')) need(!created.length, '出现了额外成员');
    if (outcome.forbidden.includes('membership_change')) need(!added.length && !report.removedMembers.length, '群成员有变更');
    if (outcome.forbidden.includes('start_session') || outcome.forbidden.includes('pi_as_substitute'))
      need(!report.calls.some(c => c.tool === 'open_session'), '尝试启动执行会话');
    if (outcome.forbidden.includes('write_file')) need(!report.calls.some(c => c.tool === 'save_file'), '尝试写文件');
    switch (outcome.kind) {
      case 'S':
        need(!sent && report.calls.every(c => readOnly.has(c.tool)), '本应静默，本轮有发言或写操作');
        break;
      case 'N':
        need(report.calls.some(c => op(c) === 'find.bot' && c.state === 'completed' && !c.args.scope), '没有查询可用成员目录');
        need(created.length === 1 && !created[0].bundled_id && added.includes(created[0].id), '未完成新建一名业务成员并入群');
        need(sent, '没有公开交接'); break;
      case 'R':
        need(!created.length && added.includes(realTarget), '未将指定的已有成员加入群');
        need(sent, '没有公开交接'); break;
      case 'H':
        need(sent, '没有向群内成员公开交接'); break;
      case 'B':
      case 'E': {
        const engines = report.workEngines;
        if (engines) {
          need(engines.before.includes(gold.bundled_id) === (outcome.kind === 'E'), '起始引擎列表与案例前提不符');
          need(engines.after.includes(gold.bundled_id), '本轮结束时指定引擎仍不可用');
        }
        need(!created.length && !report.calls.some(c => c.tool === 'create_bot'),
          '为调用工作引擎创建或请求创建了 Bot');
        need(!report.calls.some(c => c.tool === 'configure_room' &&
          (c.args.add_members?.length || c.args.remove_members?.length)), '为调用工作引擎尝试调整群成员');
        const dispatched = report.calls.some(c => c.tool === 'open_session' &&
          c.args.engine === gold.bundled_id && c.result?.target?.kind === 'session' &&
          ['submitted', 'completed'].includes(c.state) && !c.result.code && c.result.status !== 'failed');
        need(dispatched || sent, '没有提交指定引擎的会话，也没有公开交接、询问所需输入或说明阻塞');
        break;
      }
      case 'D':
        need(wrote.some(f => gold.target?.includes('《' + f.path + '》') && Boolean(f.content)), '缺少指定的群文件或内容'); break;
      case 'F':
        need(report.calls.some(c => op(c) === gold.failed_step && c.result?.code === 'replay_injected_fault'), '未触及用例设定的故障');
        need(created.length === gold.expected_new_bots_on_exit, '故障后的成员数量不符');
        need(sent, '没有公开说明阻塞'); break;
      case 'P': case 'Q':
        need(sent, '没有向群内回复'); break;
      default: throw new Error('Unknown expected reaction: ' + outcome.kind);
    }
    return { kind:outcome.kind, problems };
  }
  const alternatives = gold.accepted_outcomes.map(check);
  const candidates = alternatives.filter(a => !a.problems.length);
  const status = !candidates.length ? 'mismatch' : candidates.some(a => a.kind === 'S') ? 'match' : 'review';
  return { status, alternatives };
}
