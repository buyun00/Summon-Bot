// A project duty provisions room access and a private file workspace. A
// template, reassignment or release update is not authority to expand it.
export const TEAM_DUTY_TOOLS = Object.freeze([
  'chatroom_list', 'chatroom_read', 'chatroom_send', 'chatroom_team_read', 'chatroom_team_raise',
  'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'publish_file',
]);

export function dutyOrigin(bot) {
  const { originRoomId, originDutyKey } = bot?.lifecycle || {};
  return originRoomId && originDutyKey ? { originRoomId, originDutyKey } : null;
}

export function effectiveBotTools(bot, allowed = bot?.allowedTools) {
  if (!dutyOrigin(bot)) return allowed;
  const granted = new Set(allowed || []);
  return TEAM_DUTY_TOOLS.filter(name => granted.has(name));
}
