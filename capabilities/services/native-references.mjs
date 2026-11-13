import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPathAccess, fileAccessDenied } from '../../bot/src/capabilities/file-policy.mjs';
import { fail } from '../shared/validation.mjs';

export const nativeReferencePrefix = 'reference:';
export const nativeReferenceRoot = fileURLToPath(new URL('../references', import.meta.url));
const srgbId = `${nativeReferencePrefix}srgb-icc`;
export const nativeReferences = [{
  id: srgbId, kind: 'reference', name: 'Standard sRGB ICC profile',
  description: 'Bundled sRGB color space target profile for ICC color conversion and display output. 标准 sRGB 色彩配置文件，用于图像颜色转换。',
  filename: 'sRGB-v2-magic.icc',
  readOnly: true, enabled: true, ownerBotId: null, scopeRefs: [srgbId], dependencies: [],
  source: { name: 'Compact ICC Profiles', license: 'CC0-1.0',
    url: 'https://github.com/saucecontrol/Compact-ICC-Profiles/blob/abb1b6f48570b4eb0fabd8566e517dca07e617d4/profiles/sRGB-v2-magic.icc' },
  nativeArgument: { value: srgbId, access: 'read', kind: 'file' },
  usage: 'Pass nativeArgument.value as the parameter for the target profile in a registered CLI method with a read-only fileArgs operand. For example, set srgbProfile to this value when the method declares srgbProfile as a read file.',
}];

export const isNativeReference = value => nativeReferences.some(reference => reference.id === value);

function referenceForParameter(name) {
  const words = name.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/\bs rgb\b/g, 'srgb').split(/[ _]+/);
  if (words.includes('srgb') && (words.includes('profile') || words.includes('icc')) &&
      !words.some(word => ['input', 'source', 'src', 'from'].includes(word))) return srgbId;
}

export async function attachNativeMethodReferences(methods) {
  const matches = [];
  for (const method of methods) {
    if (!method.current || method.script || method.input || method.keepInput) continue;
    for (const { index, access, kind, prefix = '', suffix = '' } of method.fileArgs || []) {
      if (access !== 'read' || kind !== 'file') continue;
      const template = method.args?.[index];
      if (typeof template !== 'string' || !template.startsWith(prefix) || !template.endsWith(suffix)) continue;
      const operand = template.slice(prefix.length, suffix.length ? -suffix.length : undefined);
      const parameter = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(operand)?.[1];
      const id = parameter && referenceForParameter(parameter);
      if (id) matches.push({ method, id, parameter });
    }
  }
  const available = new Set(await Promise.all([...new Set(matches.map(item => item.id))].map(async id =>
    checkedNativeReference(id).then(() => id, () => null))));
  for (const { method, id, parameter } of matches) {
    if (!available.has(id)) continue;
    (method.bundledReferences ||= []).push({ id, available: true, parameters: { [parameter]: id },
      instruction: 'Use these values in catalog_native_run.parameters when the bundled reference suits the task. Supply other arguments within the original work’s file scope.' });
  }
}

export async function checkedNativeReference(id, { policy, protectedDirectories = [] } = {}) {
  const reference = nativeReferences.find(item => item.id === id);
  if (!reference) fail('Bundled reference not found. Use its exact catalog ID.', 404);
  const path = join(nativeReferenceRoot, reference.filename);
  const checkedPath = createPathAccess({ workspace: nativeReferenceRoot, protectedDirectories,
    accessPolicy: { deniedPaths: policy?.deniedPaths, grants: [{ path, kind: 'file', operations: ['read'] }] } });
  const actual = await checkedPath(path, { file: true, alternative: true });
  const info = await lstat(actual);
  if (!info.isFile() || info.nlink !== 1)
    throw fileAccessDenied(path, 'bundled_reference_path_changed', { operations: ['read'], kind: 'file' });
  await access(actual, constants.R_OK);
  return actual;
}

export async function publicNativeReference(reference) {
  const available = await checkedNativeReference(reference.id).then(() => true, () => false);
  return { ...reference, available, status: available ? 'ready' : 'unavailable',
    ...(available ? {} : { unavailableReason: 'The bundled reference file is unavailable in this installation.' }) };
}
