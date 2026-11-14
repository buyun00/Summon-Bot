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
  source: { name: 'Compact ICC Profiles', license: 'CC0-1.0',
    url: 'https://github.com/saucecontrol/Compact-ICC-Profiles/blob/abb1b6f48570b4eb0fabd8566e517dca07e617d4/profiles/sRGB-v2-magic.icc' },
}];

export const isNativeReference = value => nativeReferences.some(reference => reference.id === value);

export async function checkedNativeReference(id, { policy, protectedDirectories = [] } = {}) {
  const reference = nativeReferences.find(item => item.id === id);
  if (!reference) fail('Bundled reference not found', 404);
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

export async function nativeFileOperands() {
  return Promise.all(nativeReferences.map(async reference => {
    const available = await checkedNativeReference(reference.id).then(() => true, () => false);
    return { value: reference.id, name: reference.name, description: reference.description, source: reference.source,
      access: 'read', kind: 'file', available };
  }));
}
