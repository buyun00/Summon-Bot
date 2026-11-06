import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Detection never contacts Codex or reads account usage. Only an explicit user
// action in model settings may persist executor consent in the shared catalog.
export function desktopExecutorState({ dataRoot, connectionStore } = {}) {
  const path = connectionStore || (dataRoot && join(dataRoot, 'config', 'model-connections.json'));
  let catalog = {};
  if (path) try { catalog = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const root = dataRoot || (path && dirname(dirname(path)));
  const detected = Boolean(root && existsSync(join(root, 'connectors', 'codex-desktop-api', 'config.json')));
  const enabled = catalog.executors?.['codex-desktop']?.enabled === true;
  const status = enabled ? 'connected' : detected ? 'detected' : 'missing';
  return { id: 'codex-desktop', name: 'Codex 桌面端', role: 'executor', kind: 'codex', scope: 'host', detected, enabled, configured: enabled, status,
    label: enabled ? '已接入' : detected ? '待接入' : '未检测到',
    note: enabled ? '已允许使用运行 Summon Bot 的这台主机上的 Codex。实际执行由独立工作完成。'
      : detected ? '检测到 Codex 连接器，待手动接入。接入前不读取额度，也不调用 Codex。'
        : '待在部署机接入。安装包已包含连接器，请先打开 Codex 并准备本机会话。' };
}

export function requireDesktopExecutor(dataRoot) {
  if (!desktopExecutorState({ dataRoot }).enabled) throw Object.assign(new Error('Codex 尚未接入，请在“模型与引擎”中手动接入后再使用。'), { code: 'CODEX_NOT_CONNECTED', status: 409 });
}
