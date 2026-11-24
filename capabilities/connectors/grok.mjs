import { homedir } from 'node:os';
import { join } from 'node:path';
import { receiveMessages } from './messages-json.mjs';

export const grok = {
  id: 'grok-build', name: 'Grok Build', command: 'grok', kind: 'cli',
  guide: new URL('./grok.md', import.meta.url), source: new URL(import.meta.url),
  documentation: 'https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md',
  protocolOptions: ['--single', '--prompt-file', '--prompt-json', '--output-format', '--resume'],
  candidates: () => [join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')],
  settings(help) {
    const formats = ['streaming-messages-json', 'streaming-json', 'json'];
    const words = help.split(/[^\w-]+/);
    return { format: formats.find(format => words.includes(format)) || (help ? 'plain' : 'streaming-json'),
      promptFile: !help || help.includes('--prompt-file'), resume: !help || help.includes('--resume'),
      hideUpdateCheck: help.includes('--no-auto-update') };
  },
  invocation({ text, sessionId, settings, promptFile }) {
    const args = settings.promptFile ? ['--prompt-file', promptFile] : [`--single=${text}`];
    if (settings.format !== 'plain') args.push('--output-format', settings.format);
    if (sessionId) args.push('--resume', sessionId);
    if (settings.hideUpdateCheck) args.push('--no-auto-update');
    return { args, environment: { GROK_DISABLE_AUTOUPDATER: '1' } };
  },
  receive(message, format) {
    if (format === 'streaming-messages-json') return receiveMessages(message);
    switch (message.type) {
      case 'text': return { delta: message.data };
      case 'final_assistant_message': return { text: message.text ?? message.data };
      case 'tool_call': return { progress: message.title || message.toolName, itemId: message.toolCallId, phase: message.status, boundary: true,
        tools: [{ itemId: message.toolCallId, tool: message.toolName, status: message.status, phase: 'call',
          command: message.command ?? message.input?.command ?? message.rawInput?.command, text: message.title }] };
      case 'tool_call_update': {
        const output = typeof message.rawOutput === 'string' ? message.rawOutput : JSON.stringify(message.rawOutput ?? message.content);
        const failed = message.status === 'failed';
        return { ...(failed ? { progress: output ?? 'CLI tool failed', itemId: message.toolCallId, phase: 'tool_failed' } : {}),
          tools: [{ itemId: message.toolCallId, tool: message.toolName, status: message.status, phase: 'update',
            ...(failed ? { text: output } : {}) }] };
      }
      case 'error': return { error: message.message };
      case 'end': return { sessionId: message.sessionId, terminal: true, reason: message.stopReason };
      default: return format === 'json' && typeof message.stopReason === 'string' ?
        { text: message.text, sessionId: message.sessionId, terminal: true, reason: message.stopReason } : null;
    }
  },
  success: reason => ['success', 'end_turn', 'stop_sequence'].includes(reason),
};
