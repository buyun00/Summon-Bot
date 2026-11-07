import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const cliExecutorNames = Object.freeze({ 'codex-cli': 'Codex', grok: 'Grok Build', 'claude-code': 'Claude Code' });
export const isCliExecutor = id => Object.hasOwn(cliExecutorNames, id);
export const cliExecutorBridge = (source, id) => executorCatalog(source).executors?.[id]?.bridgePath || null;

function executorCatalog({ dataRoot, connectionStore } = {}) {
  const path = connectionStore || (dataRoot && join(dataRoot, 'config', 'model-connections.json'));
  if (path) try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {};
}

// Detection only reads Summon's local executor configuration.
export function desktopExecutorState({ dataRoot, connectionStore } = {}) {
  const catalog = executorCatalog({ dataRoot, connectionStore });
  const root = dataRoot || (connectionStore && dirname(dirname(connectionStore)));
  const detected = Boolean(root && existsSync(join(root, 'connectors', 'codex-desktop-api', 'config.json')));
  const enabled = catalog.executors?.['codex-desktop']?.enabled === true;
  const status = enabled ? 'connected' : detected ? 'detected' : 'missing';
  return { id: 'codex-desktop', name: 'Codex 桌面端', role: 'executor', kind: 'codex', scope: 'host', detected, enabled, configured: enabled, status,
    label: enabled ? '已接入' : detected ? '待接入' : '未检测到',
    note: enabled ? '已允许使用运行 Summon Bot 的这台主机上的 Codex。实际执行由独立工作完成。'
      : detected ? '检测到 Codex 连接器，待手动接入。接入前不读取额度，也不调用 Codex。'
        : '待在部署机接入。安装包已包含连接器，请先打开 Codex 并准备本机会话。' };
}

export function cliExecutorStates(catalog) {
  return Object.entries(cliExecutorNames).map(([id, name]) => {
    const enabled = catalog.executors?.[id]?.enabled === true;
    return { id, name, kind: id, role: 'executor', scope: 'host', enabled, configured: enabled,
      label: enabled ? '已接入' : '待接入', note: id === 'codex-cli'
        ? '确认后使用这台电脑已登录的 Codex 订阅，工作会话自动创建。'
        : enabled ? '使用部署机上已登录的命令行工具执行工作。' : '请在部署机安装并登录后接入。' };
  });
}

export function workExecutorChoices(source) {
  const catalog = executorCatalog(source);
  const desktop = desktopExecutorState(source);
  return { defaultId: catalog.workExecutorId || null, executors: [...cliExecutorStates(catalog), ...(desktop.enabled ? [desktop] : [])] };
}

export function selectedWorkExecutor(source) {
  const catalog = executorCatalog(source);
  const id = catalog.workExecutorId;
  if (catalog.executors?.[id]?.enabled === true) {
    if (id === 'codex-desktop') return { kind: 'codex', target: { type: 'projectless' } };
    if (isCliExecutor(id)) return { kind: id };
  }
  return { kind: 'pi' };
}

export function requireCliExecutor(source, id) {
  if (!isCliExecutor(id) || executorCatalog(source).executors?.[id]?.enabled !== true) {
    throw Object.assign(new Error('请先在模型与引擎中接入这个工作引擎。'), { status: 409, code: 'WORK_ENGINE_NOT_CONNECTED' });
  }
}

export function requireDesktopExecutor(dataRoot) {
  if (!desktopExecutorState({ dataRoot }).enabled) throw Object.assign(new Error('Codex 桌面会话接口尚未授权。工作引擎的连接状态可在「模型与引擎」中查看。'), { code: 'CODEX_NOT_CONNECTED', status: 409 });
}
