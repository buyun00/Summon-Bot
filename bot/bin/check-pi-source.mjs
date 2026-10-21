#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path));
const hash = path => createHash('sha256').update(read(path)).digest('hex');
const manifest = JSON.parse(read('third_party/pi/SOURCES.json'));
for (const entry of manifest.modules) {
  if (hash(entry.original) !== entry.upstreamSha256) throw new Error(`Original source changed: ${entry.original}`);
  if (hash(entry.local) !== entry.localSha256) throw new Error(`Review and record local source change: ${entry.local}`);
}
for (const entry of manifest.tests) {
  if (hash(entry.original) !== entry.sha256 || hash(entry.local) !== entry.localSha256) throw new Error(`Unrecorded test source change: ${entry.local}`);
}
for (const entry of [...manifest.relayWrappers, ...manifest.fixtures]) if (hash(entry.local) !== entry.localSha256) throw new Error(`Unrecorded support file change: ${entry.local}`);
const pkg = JSON.parse(read('package.json'));
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core']) if (pkg.dependencies[name] !== manifest.version) throw new Error(`Unreviewed Pi version: ${name}`);
console.log(`${manifest.modules.length} Pi source files verified at ${manifest.commit}`);
