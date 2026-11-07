import { basename, isAbsolute, relative, resolve } from 'node:path';

export const FILE_ACCESS_GUIDANCE = 'A file access refusal is a permission/protection boundary, not a missing tool or an ordinary command error. Do not switch to shell, another API, a copy or a renamed path to perform the refused file operation. Preserve the restriction and report the actual result; other authorized paths and operations may continue.';

export function fileAccessDenied(path, reason, extra = {}) {
  return Object.assign(new Error(`File access refused (${reason}). ${FILE_ACCESS_GUIDANCE}`), {
    status: 403, code: 'FILE_ACCESS_DENIED', accessDenial: { path, reason, ...extra },
  });
}

const contains = (root, path) => {
  const part = relative(root, path);
  return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
};

export function assertPathPolicy(path, policy = {}) {
  for (const constraint of policy.deniedPaths || []) if (contains(resolve(constraint.path), path))
    throw fileAccessDenied(path, constraint.reason || 'prior_access_refusal', {
      sourceMessageId: constraint.sourceMessageId, originalPath: constraint.path,
    });
}

// These are literal command operands, not a claim that a shell is an OS sandbox.
// Quoted content with newlines is document data, not a path operand. Check both
// absolute paths and relative file operands; resolving only cwd allowed the
// same refused file to be read/written through PowerShell/.NET instead.
export function commandPathOperands(command) {
  const paths = new Set();
  const literals = command.matchAll(/'((?:[^']|'')*)'|"((?:`.|[^"`])*)"/g);
  for (const match of literals) {
    const value = (match[1] !== undefined ? match[1].replaceAll("''", "'") : match[2].replace(/`([`"$])/g, '$1')).trim();
    if (!value || value.length > 1024 || /[\r\n\0]/.test(value) || /^(?:https?|data):/i.test(value)) continue;
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\.{0,2}[\\/])/.test(value) || /^[\w.-]+\.[A-Za-z0-9]{1,16}$/.test(value)) paths.add(value);
  }
  for (const match of command.matchAll(/(?:^|[\s(,=])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s'";,(){}]+)/g)) paths.add(match[1]);
  return [...paths];
}

export async function assertCommandPolicy(command, cwd, policy, checkOperand) {
  // Normalize simple literal concatenation/backtick spelling before checking a
  // denied target. Opaque payloads cannot establish that a refused operation is
  // unrelated, so use ordinary explicit commands for the remaining work.
  const visible = command.replace(/(['"])\s*\+\s*\1/g, '').replace(/`(?=[A-Za-z_.-])/g, '').replaceAll('\\', '/').toLowerCase();
  const constraints = policy?.deniedPaths || [];
  for (const constraint of constraints) {
    const full = resolve(constraint.path).replaceAll('\\', '/').toLowerCase();
    const name = basename(full);
    if (visible.includes(full) || name && visible.includes(name)) throw fileAccessDenied(constraint.path, constraint.reason || 'prior_access_refusal');
  }
  if (constraints.length && /(?:-(?:encodedcommand|enc)\b|frombase64string\s*\(|\b(?:invoke-expression|iex|eval|exec)\b|\b(?:node|python\d*|ruby|perl)\s+-(?:e|c)\b)/i.test(visible))
    throw fileAccessDenied(constraints[0].path, 'opaque_command_with_access_restriction');
  if (constraints.length && /(?:\b(?:get-content|set-content|add-content|out-file|remove-item|move-item|copy-item|select-string)\b|readalltext|writealltext)/i.test(visible) && /[*?]/.test(visible))
    throw fileAccessDenied(constraints[0].path, 'wildcard_file_access_with_restriction');
  for (const operand of commandPathOperands(command)) {
    const path = resolve(cwd, operand);
    assertPathPolicy(path, policy);
    await checkOperand(path);
  }
}
