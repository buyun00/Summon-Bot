import { homedir } from 'node:os';
import { join } from 'node:path';
import { receiveMessages } from './messages-json.mjs';

export const claude = {
  id: 'claude-code', name: 'Claude Code', command: 'claude', kind: 'cli',
  guide: new URL('./claude.md', import.meta.url), source: new URL(import.meta.url),
  documentation: 'https://code.claude.com/docs/en/headless.md',
  protocolOptions: ['--print', '--input-format', '--output-format', '--json-schema', '--verbose', '--resume', '--continue', '--session-id',
    '--fork-session', '--no-session-persistence', '--from-pr', '--add-dir', '--worktree', '--background', '--bg', '--cloud', '--teleport',
    '--permission-prompts', '--ide', '--chrome', '--remote-control', '--tmux'],
  candidates: roots => process.platform === 'win32' ? [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    ...roots.map(root => join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')),
  ] : [join(homedir(), '.local', 'bin', 'claude')],
  settings(help) {
    const format = !help || help.includes('stream-json') && help.includes('--output-format') ? 'stream-json' :
      help.includes('--output-format') ? 'json' : 'plain';
    return { format, resume: !help || help.includes('--resume'), verbose: format === 'stream-json' && (!help || help.includes('--verbose')),
      permissionPrompts: help.includes('--permission-prompts') };
  },
  invocation({ text, sessionId, settings }) {
    const args = ['--print'];
    if (settings.format !== 'plain') args.push('--output-format', settings.format);
    if (settings.verbose) args.push('--verbose');
    if (settings.permissionPrompts) args.push('--permission-prompts', 'none');
    if (sessionId) args.push('--resume', sessionId);
    return { args, stdin: text };
  },
  receive: receiveMessages,
  success: reason => ['success', 'end_turn', 'stop_sequence'].includes(reason),
};
