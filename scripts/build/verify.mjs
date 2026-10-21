import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, digest, within, walk, parseArgs } from './files.mjs';

export async function verifyRelease(releaseRoot, { integrity = false } = {}) {
  releaseRoot = resolve(releaseRoot);
  const manifest = await readJson(join(releaseRoot, 'release-manifest.json'));
  if (manifest.format !== 2) throw new Error('Unsupported release format');
  if (!integrity || manifest.profile === 'development') return { valid: true, profile: manifest.profile || 'release', integrityChecked: false,
    buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, files: Object.keys(manifest.files || {}).length, contentHash: manifest.contentHash ?? null };
  const errors = [];
  const actual = await walk(releaseRoot);
  for (const file of actual) if (file.name !== 'release-manifest.json' && !manifest.files[file.name]) errors.push(`Unrecorded file: ${file.name}`);
  const entries = Object.entries(manifest.files);
  for (let index = 0; index < entries.length; index += 64) await Promise.all(entries.slice(index, index + 64).map(async ([name, expected]) => {
    const path = resolve(releaseRoot, name);
    if (!within(releaseRoot, path) || path === releaseRoot) { errors.push(`Invalid path: ${name}`); return; }
    try { const bytes = await readFile(path); if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) errors.push(`Changed file: ${name}`); }
    catch { errors.push(`Missing file: ${name}`); }
  }));
  if (digest(JSON.stringify(manifest.files)) !== manifest.contentHash) errors.push('Manifest content hash mismatch');
  if (errors.length) throw new Error(errors.join('\n'));
  return { valid: true, profile: manifest.profile || 'release', integrityChecked: true, buildId: manifest.buildId,
    sourceCommit: manifest.sourceCommit, files: Object.keys(manifest.files).length, contentHash: manifest.contentHash };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options, positional } = parseArgs(process.argv.slice(2));
  verifyRelease(options['release-root'] || positional[0] || '.', { integrity: options['with-integrity'] === true || options['with-integrity'] === 'true' })
    .then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
