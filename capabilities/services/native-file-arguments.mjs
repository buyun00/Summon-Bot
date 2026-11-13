import { assertCommandPolicy, createAuthorizedDirectory, fileAccessDenied, resolveFilePath } from '../../bot/src/capabilities/file-policy.mjs';
import { fail } from '../shared/validation.mjs';

const operations = { read: ['read'], write: ['write'], 'read-write': ['read', 'write'] };
const explicitPath = /(?:[A-Za-z]:[\\/]|(^|[=: "'\x60])(?:[/\\]{2}|\.{1,2}[\\/]|\/(?![a-z?]+$))|[A-Za-z0-9_.-][\\/][^/\\])|(?:^|[=: "'\x60])[^/\\=:]+\.[a-z][a-z0-9]{0,15}$/i;
const opaqueArgument = /^(?:@|https?:|file:|ftp:)|^(?:--eval|-command|-encodedcommand|--script)(?:=|$)/i;
const helpOrVersion = /^(?:--(?:help|version)|-(?:help|version|h|v|\?)|\/(?:help|version|h|v|\?)|help|version)$/i;
const formatField = /^[A-Za-z][\w-]*=%(?:[A-Za-z]|\[[A-Za-z][\w-]*\])(?:\\[nrt])*$/;

function isFixedFormatArgument(argv, templateArgs, byIndex, index) {
  const optionIndex = index - 1;
  const option = templateArgs?.[optionIndex];
  const value = argv[index];
  if ((option !== '-format' && option !== '--format') ||
      argv[optionIndex] !== option || value !== templateArgs[index] ||
      byIndex.has(optionIndex) || argv.slice(0, optionIndex).includes('--')) return false;
  // A backslash escape is also a possible path separator. Require labeled
  // format fields after a fixed format option in the registered template.
  const fields = value.split(/ +/);
  return fields.length > 1 && fields.every(field => formatField.test(field));
}

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

export function validInspectionArgs(args) {
  return Array.isArray(args) && args.some(arg => helpOrVersion.test(arg)) &&
    args.every(arg => helpOrVersion.test(arg) || /^(?:--?)?[a-z0-9_-]+$/i.test(arg) && !opaqueArgument.test(arg));
}

export function inspectOnlyArgs(args) {
  if (!validInspectionArgs(args))
    fail('Use the documented version or help invocation for a probe. Use a work method for operations with paths or other arguments.');
}

export function hasExplicitFileScope(policy) {
  return Boolean(policy?.grants?.length || policy?.deniedPaths?.some(item => !item.alternativesOnly));
}

export async function checkedNativeArguments({ argv, templateArgs, fileArgs, effect, cwd, policy, checkedPath, createOutputs = false }) {
  const scoped = hasExplicitFileScope(policy);
  const byIndex = new Map(nativeFileArgs(fileArgs, argv.length, effect).map(item => [item.index, item]));
  const planned = [];
  for (const [index, value] of argv.entries()) {
    const definition = byIndex.get(index);
    if (scoped && opaqueArgument.test(value))
      throw fileAccessDenied(cwd, 'opaque_native_argument', { argumentIndex: index });
    if (!definition) {
      if (!explicitPath.test(value) || helpOrVersion.test(value) ||
          isFixedFormatArgument(argv, templateArgs, byIndex, index)) continue;
      if (scoped) throw fileAccessDenied(cwd, 'undeclared_native_path_operand', {
        argumentIndex: index, instruction: 'Use fileArgs to declare the exact read or write operand and its argument index.',
      });
      const operand = value.startsWith('-') && value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
      if (/^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])/.test(operand))
        await checkedPath(resolveFilePath(cwd, operand), { operations: effect === 'read' ? ['read'] : ['read', 'write'], alternative: true });
      continue;
    }
    const { kind, access, prefix, suffix } = definition;
    if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length <= prefix.length + suffix.length)
      fail('A native path operand did not match its registered argument shape');
    const operand = value.slice(prefix.length, suffix.length ? -suffix.length : undefined);
    if (/[@*?\r\n]/.test(operand) || /^(?:file|https?|ftp):/i.test(operand))
      throw fileAccessDenied(cwd, 'unresolved_native_path_operand', { argumentIndex: index });
    const path = resolveFilePath(cwd, operand);
    const write = operations[access].includes('write');
    const options = { operations: operations[access], alternative: true, exists: operations[access].includes('read'), [kind]: true };
    await checkedPath(path, options);
    planned.push({ index, prefix, suffix, path, kind, write, options });
  }
  await assertCommandPolicy(argv.map(value => JSON.stringify(value)).join(' '), cwd, policy,
    (path, allowed) => checkedPath(path, { operations: allowed, alternative: true }));
  const result = [...argv];
  for (const item of planned) {
    if (createOutputs && item.write) await createAuthorizedDirectory(item.path, checkedPath, {
      parentOfFile: item.kind === 'file', alternative: true,
    });
    result[item.index] = item.prefix + await checkedPath(item.path, item.options) + item.suffix;
  }
  return result;
}
