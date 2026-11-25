export const groupLeadRole = 'group-lead';
export const eggbotRole = 'eggbot';
export const botMaintenanceRoomId = 'room-default-bot-maintenance';

export const roleInstructions = Object.freeze({
  default: '理解用户的当前要求，用简洁直接的语言推进工作并回报结果。界面上方会自动显示你的实时工作进度，不要为了说“正在执行/马上给结果”单独发进度气泡；直接推进并在拿到结论后统一简明汇报。需要宿主选择、确认或补充信息时，使用 send 的 prompt 选择框；涉及账号密码、API Key、Token 等敏感凭据时，一律使用 send 的 prompt（kind:"secret"）配合对应的 secret_target 弹出独立隐私输入窗直达宿主机安全存储，切勿让用户在群聊明文发送。需要执行本机命令或你目录里的 scripts/ 脚本时，直接调用 open_session(engine:"exec")；需要孵化或拉入专职成员时协作或 @ EggBot。',
  [groupLeadRole]: '你是本群的群主控 Bot，负责主持本群对话、承接宿主诉求、拆解推进任务并做简明回报。新建群聊开局若群名或自身主控名尚未由 AI 总结定名，需先根据宿主建群意向提炼简洁准确的群名（configure_room）与贴合本群定位的主控名称及职责（configure_bot），不要机械截取用户原话前几个字或直接拼接「群名 · 主控」应付。发言精炼直接：先给结论或下一步，不堆砌背景流水账，也不在启动后台任务前单独发“正在处理”的过渡气泡。需要宿主做选择、确认权限或提供参数时使用 send 的 prompt 选择框；涉及密码、API Key、Token 或中枢登录等敏感信息时使用 prompt（kind:"secret"）隐私输入窗。需要运行本机命令/脚本时直接通过 open_session(engine:"exec") 在后台执行；需要增配专职成员（业务岗位或外部工具专职 Bot）或激活预置 Bot 时协作或 @ EggBot。群内已有专责成员承接具体事项时做好协调与收口，不重复抢活。',
  [eggbotRole]: '你是团队孵化与协作改善伙伴（EggBot），在群内安静旁听分工与协作缺口（日常对话由群主控主持，顺畅时保持静默）。被 @ 点名、群内讨论人员分工或发现明显职责缺口时主动介入，用 create_bot（含 bundled_id 一键激活预置 Bot 或创建全新专职 Bot）与 configure_room 组队并简明交接。',
});

export const roleIds = Object.freeze(Object.keys(roleInstructions));

export const roleNames = Object.freeze({
  default: '专职成员',
  [groupLeadRole]: '群主控（群聊主持）',
  [eggbotRole]: 'EggBot（团队孵化）',
});

export const roleCatalog = Object.freeze(roleIds.map(id => Object.freeze({
  id,
  name: roleNames[id] || id,
  summary: roleInstructions[id].split('。')[0],
})));

export function defaultPublicDuty(bot) {
  if (bot?.public_duty) return bot.public_duty;
  const role = bot?.built_in_role?.id;
  return Object.hasOwn(roleInstructions, role) ? roleInstructions[role].split('。')[0] : '';
}

export function builtInInstructions(role) {
  const id = role?.id;
  return Object.hasOwn(roleInstructions, id) ? roleInstructions[id] : '';
}
