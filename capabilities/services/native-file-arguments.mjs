import { isAbsolute, parse } from 'node:path';
import { fileAccessDenied, resolveFilePath } from '../../bot/src/capabilities/file-policy.mjs';
import { fail } from '../shared/validation.mjs';
import { isNativeReference, nativeReferencePrefix } from './native-references.mjs';

const operations = { read: ['read'], write: ['write'], 'read-write': ['read', 'write'] };

export function nativeFileArgs(input = [], length, effect) {
  if (!Array.isArray(input) || input.length > 128) fail('File arguments must name distinct argument indexes');
  const indexes = new Set();
  return input.map(item => {
    const { index, access, kind = 'file', prefix = '', suffix = '' } = item || {};
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || indexes.has(index) ||
      !Object.hasOwn(operations, access) || !['file', 'directory'].includes(kind) ||
      [prefix, suffix].some(value => typeof value !== 'string' || value.length > 128 || /[\0\r\n]/.test(value)) ||
      effect === 'read' && operations[access].includes('write')) fail('Each file argument needs its exact index, access and path kind');
    indexes.add(index);
    return { index, access, kind, prefix, suffix };
  });
}

export function hasExplicitFileScope(policy) {
  return Boolean(policy?.grants?.length || policy?.deniedPaths?.some(item => !item.alternativesOnly));
}

function fileOperand(value, { prefix = '', suffix = '' }) {
  if (value.startsWith(prefix) && value.endsWith(suffix) && value.length > prefix.length + suffix.length)
    return value.slice(prefix.length, suffix.length ? -suffix.length : undefined);
}

export async function checkedNativeArguments({ argv, fileArgs, effect, cwd, hasFileScope, checkedPath, resolveReference }) {
  const roles = nativeFileArgs(fileArgs, argv.length, effect);
  const byIndex = new Map(roles.map(item => [item.index, item]));
  const result = [...argv];
  for (const [index, value] of argv.entries()) {
    const definition = byIndex.get(index);
    if (!definition) {
      if (isNativeReference(value)) throw fileAccessDenied(cwd, 'invalid_native_reference_operand', { argumentIndex: index });
      if (hasFileScope) {
        const operand = /^--?[a-z0-9_-]+=([^\n]+)$/i.exec(value)?.[1] ?? value;
        const absolute = isAbsolute(operand) && (process.platform !== 'win32' || parse(operand).root.length > 1);
        if (absolute || /^\.{1,2}[\\/]/.test(operand)) {
          throw fileAccessDenied(cwd, 'undeclared_native_path_operand', {
            argumentIndex: index, instruction: 'Declare the exact file argument index and access using file_args.',
          });
        }
      }
      continue;
    }
    const { kind, access, prefix, suffix } = definition;
    const operand = fileOperand(value, definition);
    if (!operand) fail('A native path operand did not match its registered argument shape');
    if (operand.startsWith(nativeReferencePrefix)) {
      if (!resolveReference || kind !== 'file' || access !== 'read')
        throw fileAccessDenied(cwd, 'invalid_native_reference_operand', { argumentIndex: index });
      result[index] = prefix + await resolveReference(operand) + suffix;
      continue;
    }
    if (/[*?\r\n]/.test(operand) || /^(?:file|https?|ftp):/i.test(operand))
      throw fileAccessDenied(cwd, 'unresolved_native_path_operand', { argumentIndex: index });
    const path = resolveFilePath(cwd, operand);
    const options = { operations: operations[access], alternative: true, exists: operations[access].includes('read'), [kind]: true };
    result[index] = prefix + await checkedPath(path, options) + suffix;
  }
  return result;
}
