import { resolve } from 'node:path';
import { desktopExecutorState, requireDesktopExecutor } from '../../../bot/src/capabilities/executor-connections.mjs';

const dataRoot = config => resolve(config.dataDir, '../..');
export const executorState = config => desktopExecutorState({ dataRoot: dataRoot(config) });
export const assertExecutorConnected = config => requireDesktopExecutor(dataRoot(config));
