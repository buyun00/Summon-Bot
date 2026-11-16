import { codex } from './codex.mjs';
import { grok } from './grok.mjs';
import { claude } from './claude.mjs';

export const connectors = [codex, grok, claude];
export const connectorFor = id => connectors.find(connector => connector.id === id);

export const launchArguments = (options, resume) => [...(options?.common || []), ...(options?.[resume ? 'resume' : 'start'] || [])];
