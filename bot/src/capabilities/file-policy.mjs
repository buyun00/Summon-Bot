import { isAbsolute, relative, resolve } from 'node:path';

export const FILE_ACCESS_GUIDANCE = 'A file access refusal is a permission/protection boundary, not a missing tool or an ordinary command error. Do not switch to shell, another API, a copy or a renamed path to perform the refused file operation. Report the exact attempted operation and refusal reason. A refused read does not establish that a write was attempted or refused; distinguish an original user prohibition from an observed tool denial. Preserve the restriction and report the actual result; other authorized paths and operations may continue.';

export function fileAccessDenied(path, reason, extra = {}) {
  return Object.assign(new Error(`File access refused (${reason}). ${FILE_ACCESS_GUIDANCE}`), {
    status: 403, code: 'FILE_ACCESS_DENIED', accessDenial: { path, reason, ...extra },
  });
}

const contains = (root, path) => {
  const part = relative(root, path);
  return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
};

export function assertPathPolicy(path, policy = {}, { operations = ['read', 'write'], alternative = false } = {}) {
  for (const constraint of policy.deniedPaths || []) if ((!constraint.alternativesOnly || alternative) &&
    operations.some(operation => (constraint.operations || ['read', 'write']).includes(operation)) && contains(resolve(constraint.path), path))
    throw fileAccessDenied(path, constraint.reason || 'prior_access_refusal', {
      sourceMessageId: constraint.sourceMessageId, originalPath: constraint.path, operations,
      blockedOperations: operations.filter(operation => (constraint.operations || ['read', 'write']).includes(operation)),
      originReason: constraint.originReason || constraint.reason,
    });
}

// A bounded lexer keeps quoted document data out of command recognition. This
// is for explicit PowerShell/.NET file operations, not a new OS sandbox.
function commandTokens(command) {
  const tokens = [];
  for (let i = 0; i < command.length;) {
    const char = command[i];
    if (char === '\r' || /[^\S\n]/.test(char)) { i++; continue; }
    if (char === '#') { while (i < command.length && command[i] !== '\n') i++; continue; }
    if (char === '@' && /['"]/.test(command[i + 1]) && /[\r\n]/.test(command[i + 2])) {
      const quote = command[i + 1], end = new RegExp(`\\r?\\n${quote}@`, 'g'); end.lastIndex = i + 2;
      const match = end.exec(command); tokens.push({ kind: 'string', value: command.slice(i + 2, match?.index ?? command.length) }); i = match ? end.lastIndex : command.length; continue;
    }
    if (char === "'" || char === '"') {
      const quote = char; let value = ''; i++;
      while (i < command.length) {
        if (command[i] === quote) { if (quote === "'" && command[i + 1] === quote) { value += quote; i += 2; continue; } i++; break; }
        if (quote === '"' && command[i] === '`' && i + 1 < command.length) { value += command[i + 1]; i += 2; } else value += command[i++];
      }
      tokens.push({ kind: 'string', value }); continue;
    }
    if ('=(),;|{}\n&+'.includes(char)) { tokens.push({ kind: 'symbol', value: char }); i++; continue; }
    const start = i;
    while (i < command.length && !/[\s'"=(),;|{}&+]/.test(command[i])) i++;
    tokens.push({ kind: 'word', value: command.slice(start, i).replace(/`(?=[A-Za-z_.-])/g, '') });
  }
  return tokens;
}
function argumentsAfter(tokens, index) {
  const groups = [[]]; let depth = 1;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'symbol' && token.value === '(') depth++;
    if (token.kind === 'symbol' && token.value === ')' && !--depth) break;
    if (token.kind === 'symbol' && token.value === ',' && depth === 1) groups.push([]); else groups.at(-1).push(token);
  }
  return groups;
}
const readCommands = new Set(['get-content', 'gc', 'cat', 'type', 'get-item', 'test-path', 'get-childitem', 'select-string']);
const writeCommands = new Set(['set-content', 'add-content', 'out-file', 'remove-item', 'new-item']);
const readMethods = new Set(['readalltext', 'readalllines', 'readallbytes', 'openread', 'readfilesync', 'readfile', 'exists', 'enumeratefiles', 'getfiles']);
const writeMethods = new Set(['writealltext', 'writealllines', 'writeallbytes', 'appendalltext', 'openwrite', 'writefilesync', 'writefile', 'delete', 'createdirectory']);
function commandFileAccesses(command) {
  const tokens = commandTokens(command), variables = new Map(), accesses = [];
  const value = parts => {
    if (!parts?.length) return null;
    if (parts.length > 1) return parts.every((token, i) => i % 2 ? token.value === '+' : token.kind === 'string') ? parts.filter((_, i) => i % 2 === 0).map(token => token.value).join('') : null;
    const token = parts[0];
    if (token.kind === 'string') return token.value.includes('$') || /[\r\n]/.test(token.value) ? null : token.value;
    if (/^\$[\w]+$/.test(token.value)) return variables.get(token.value.toLowerCase()) ?? null;
    return token.kind === 'word' && !token.value.startsWith('-') ? token.value : null;
  };
  const add = (parts, operations) => accesses.push({ path: value(parts), operations });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; if (token.kind !== 'word') continue;
    if (/^\$\w+$/.test(token.value) && tokens[i + 1]?.value === '=') {
      const end = tokens.findIndex((item, j) => j > i + 1 && item.kind === 'symbol' && [';', '\n', '}'].includes(item.value));
      const assigned = value(tokens.slice(i + 2, end < 0 ? undefined : end));
      variables.set(token.value.toLowerCase(), assigned); continue;
    }
    const method = /(?:\]::|\.)([a-z]+)$/i.exec(token.value)?.[1].toLowerCase();
    if (method && tokens[i + 1]?.value === '(') {
      const args = argumentsAfter(tokens, i + 1);
      if (readMethods.has(method)) add(args[0], ['read']);
      else if (writeMethods.has(method)) add(args[0], ['write']);
      else if (['copy', 'move'].includes(method)) { add(args[0], method === 'copy' ? ['read'] : ['write']); add(args[1], ['write']); }
      continue;
    }
    const name = token.value.toLowerCase();
    if (!readCommands.has(name) && !writeCommands.has(name) && !['copy-item', 'move-item', 'rename-item'].includes(name)) continue;
    const end = tokens.findIndex((item, j) => j > i && item.kind === 'symbol' && [';', '\n', '|', '}', '{'].includes(item.value));
    const body = tokens.slice(i + 1, end < 0 ? undefined : end);
    const flag = names => {
      const index = body.findIndex(item => item.kind === 'word' && names.includes(item.value.toLowerCase()));
      if (index < 0) return null;
      const parts = []; let j = index + 1, depth = 0;
      while (j < body.length) {
        const next = body[j];
        if (!depth && parts.length && ![',', '+'].includes(next.value) && ![',', '+'].includes(parts.at(-1).value)) break;
        if (!depth && next.kind === 'word' && next.value.startsWith('-')) break;
        if (next.value === '(') depth++; if (next.value === ')') depth--;
        parts.push(next); j++;
      }
      return parts;
    };
    const positionals = [];
    for (let j = 0; j < body.length; j++) {
      if (body[j].kind === 'word' && body[j].value.startsWith('-')) {
        if (['-encoding', '-erroraction', '-ea', '-filter', '-include', '-exclude', '-value', '-inputobject', '-pattern', '-itemtype'].includes(body[j].value.toLowerCase())) j++;
        continue;
      }
      if (body[j].kind !== 'symbol') positionals.push([body[j]]);
    }
    const source = flag(['-literalpath', '-path', '-filepath']) || positionals[name === 'select-string' && !body.some(item => item.value.toLowerCase() === '-pattern') ? 1 : 0];
    const sources = source?.some(item => item.value === ',') ? source.reduce((groups, item) => { if (item.value === ',') groups.push([]); else groups.at(-1).push(item); return groups; }, [[]]) : [source];
    for (const path of sources) add(path, readCommands.has(name) || name === 'copy-item' ? ['read'] : ['write']);
    if (['copy-item', 'move-item', 'rename-item'].includes(name)) add(flag(['-destination', '-newname']) || positionals[1], ['write']);
  }
  return accesses;
}

export async function assertCommandPolicy(command, cwd, policy, checkOperand) {
  // Normalize simple literal concatenation/backtick spelling before checking a
  // denied target. Opaque payloads cannot establish that a refused operation is
  // unrelated, so use ordinary explicit commands for the remaining work.
  const visible = command.replace(/(['"])\s*\+\s*\1/g, '').replace(/`(?=[A-Za-z_.-])/g, '').replaceAll('\\', '/').toLowerCase();
  const constraints = policy?.deniedPaths || [];
  if (constraints.length && /(?:-(?:encodedcommand|enc)\b|frombase64string\s*\(|\b(?:invoke-expression|iex|eval|exec)\b|\b(?:node|python\d*|ruby|perl)\s+-(?:e|c)\b)/i.test(visible))
    throw fileAccessDenied(constraints[0].path, 'opaque_command_with_access_restriction');
  for (const access of commandFileAccesses(command)) {
    const relevant = constraints.filter(constraint => access.operations.some(operation => (constraint.operations || ['read', 'write']).includes(operation)));
    if (!access.path || /[*?]/.test(access.path)) {
      if (relevant.length) throw fileAccessDenied(relevant[0].path, 'unresolved_command_file_target', { originReason: relevant[0].originReason, operations: access.operations });
      continue;
    }
    const path = resolve(cwd, access.path);
    assertPathPolicy(path, policy, { operations: access.operations, alternative: true });
    await checkOperand(path, access.operations);
  }
}
