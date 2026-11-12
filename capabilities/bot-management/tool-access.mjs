import { nativeToolDefinitions } from '../services/native-tool-definitions.mjs';

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
  if (!dutyOrigin(bot)) {
    if (!allowed) return allowed;
    const values = allowed.filter(name => !name.startsWith('codex_'));
    if (values.includes('catalog_search')) values.push(...nativeToolDefinitions.filter(tool => tool.effect === 'read').map(tool => tool.name));
    if (values.includes('catalog_call')) values.push(...nativeToolDefinitions.filter(tool => /_(run|input|stop|recover)$/.test(tool.name)).map(tool => tool.name));
    if (values.includes('catalog_register')) values.push('catalog_native_enroll');
    return [...new Set(values)];
  }
  const granted = new Set(allowed || []);
  return TEAM_DUTY_TOOLS.filter(name => granted.has(name));
}
