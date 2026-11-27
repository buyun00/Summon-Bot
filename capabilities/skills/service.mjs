import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { reject } from '../platform/contract.mjs';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function capabilitiesDataRoot(dataRoot) {
  return join(resolve(dataRoot), 'skills');
}

export function bundledCapabilitiesRoot(releaseRoot) {
  return join(resolve(releaseRoot), 'bundled-skills');
}

export function capabilityRootDir(dataRoot, capabilityId) {
  if (typeof capabilityId !== 'string' || !safeId.test(capabilityId)) {
    reject('invalid_capability', 'Invalid capability ID');
  }
  return join(capabilitiesDataRoot(dataRoot), capabilityId);
}

export function validateCapabilityRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > 300 || /[\\:\0\p{Cc}]/u.test(relPath)) {
    reject('invalid_path', 'Use a safe relative POSIX path inside the capability folder');
  }
  const clean = relPath.trim().replace(/^\/+/, '');
  const parts = clean.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    reject('invalid_path', 'Path cannot traverse outside the capability folder');
  }
  return clean;
}

function walkRelativeFiles(baseDir, prefix = '', out = []) {
  if (!existsSync(baseDir)) return out;
  for (const entry of readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const abs = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      walkRelativeFiles(abs, rel, out);
    } else if (entry.isFile()) {
      const info = statSync(abs);
      out.push({ path: rel, size: info.size, updated_at: info.mtime.toISOString() });
    }
  }
  return out;
}

function unquoteScalar(raw) {
  const text = raw.trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text.replace(/\s+#.*$/, '').trim();
}

function parseListValue(raw) {
  const clean = raw.trim().replace(/\s+#.*$/, '').trim();
  if (!clean.startsWith('[') || !clean.endsWith(']')) return null;
  const inner = clean.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(item => unquoteScalar(item)).filter(Boolean);
}

export function parseSkillMarkdown(raw, fallbackId) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = text.trim();

  if (text.startsWith('---\n')) {
    const endIdx = text.indexOf('\n---', 4);
    if (endIdx !== -1) {
      const afterEnd = endIdx + 4;
      const validBoundary = afterEnd >= text.length || text[afterEnd] === '\n';
      if (validBoundary) {
        const header = text.slice(4, endIdx);
        body = text.slice(afterEnd).trim();
        let activeListKey = null;
        for (const rawLine of header.split('\n')) {
          const line = rawLine.trimEnd();
          if (!line.trim() || line.trimStart().startsWith('#')) continue;
          const listMatch = activeListKey && line.match(/^\s*-\s+(.+)$/);
          if (listMatch) {
            const val = unquoteScalar(listMatch[1]);
            if (val) meta[activeListKey].push(val);
            continue;
          }
          activeListKey = null;
          const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          if (!kv) continue;
          const key = kv[1];
          const valRaw = kv[2].trim();
          if (!valRaw) {
            meta[key] = [];
            activeListKey = key;
            continue;
          }
          const inlineList = parseListValue(valRaw);
          if (inlineList !== null) {
            meta[key] = inlineList;
          } else {
            const scalar = unquoteScalar(valRaw);
            if (scalar === 'null' || scalar === '~') meta[key] = null;
            else if (scalar === 'true') meta[key] = true;
            else if (scalar === 'false') meta[key] = false;
            else meta[key] = scalar;
          }
        }
      }
    }
  }

  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackId;
  const firstBodyLine = body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  const description = typeof meta.description === 'string' && meta.description.trim()
    ? meta.description.trim()
    : firstBodyLine.slice(0, 200);
  const enabled = typeof meta.enabled === 'boolean' ? meta.enabled : true;
  const owner_bot = typeof meta.owner_bot === 'string' && meta.owner_bot.trim() ? meta.owner_bot.trim() : null;
  const room_id = typeof meta.room_id === 'string' && meta.room_id.trim() ? meta.room_id.trim() : null;
  const env_slots = Array.isArray(meta.env_slots)
    ? [...new Set(meta.env_slots.filter(v => typeof v === 'string' && envNameRe.test(v)))]
    : [];

  return { id: fallbackId, name, description, enabled, owner_bot, room_id, env_slots, body };
}

export class CapabilityManager {
  constructor({ dataRoot, releaseRoot }) {
    Object.assign(this, { dataRoot: resolve(dataRoot), releaseRoot: resolve(releaseRoot) });
  }

  dir() {
    return capabilitiesDataRoot(this.dataRoot);
  }

  bundledIds() {
    const srcRoot = bundledCapabilitiesRoot(this.releaseRoot);
    if (!existsSync(srcRoot)) return new Set();
    const ids = new Set();
    for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && safeId.test(entry.name) && existsSync(join(srcRoot, entry.name, 'SKILL.md'))) {
        ids.add(entry.name);
      }
    }
    return ids;
  }

  isBundled(id) {
    return this.bundledIds().has(id);
  }

  ensureDefaults() {
    const destRoot = capabilitiesDataRoot(this.dataRoot);
    mkdirSync(destRoot, { recursive: true });
    const srcRoot = bundledCapabilitiesRoot(this.releaseRoot);
    if (!existsSync(srcRoot)) return;
    for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
      const srcDir = join(srcRoot, entry.name);
      if (!existsSync(join(srcDir, 'SKILL.md'))) continue;
      const destDir = join(destRoot, entry.name);
      mkdirSync(destDir, { recursive: true });
      for (const file of walkRelativeFiles(srcDir)) {
        const destFile = join(destDir, ...file.path.split('/'));
        mkdirSync(dirname(destFile), { recursive: true });
        cpSync(join(srcDir, ...file.path.split('/')), destFile, { force: true });
      }
    }
  }

  readEntry(id, { includeContent = false, lookupBot = null, bundledSet = null } = {}) {
    const dir = capabilityRootDir(this.dataRoot, id);
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath) || !statSync(skillPath).isFile()) return null;
    const raw = readFileSync(skillPath, 'utf8');
    const parsed = parseSkillMarkdown(raw, id);
    const files = walkRelativeFiles(dir);
    const bundled = bundledSet ? bundledSet.has(id) : this.isBundled(id);
    let ownerInfo = {};
    if (parsed.owner_bot) {
      const bot = typeof lookupBot === 'function' ? lookupBot(parsed.owner_bot) : null;
      ownerInfo = {
        owner_bot: parsed.owner_bot,
        ...(typeof lookupBot === 'function' ? {
          owner_name: bot?.name || null,
          owner_alive: Boolean(bot && !bot.archivedAt && bot.enabled),
        } : {}),
      };
    }
    return {
      kind: 'capability',
      id,
      name: parsed.name,
      description: parsed.description,
      enabled: parsed.enabled,
      bundled,
      owner_bot: parsed.owner_bot,
      ...ownerInfo,
      ...(parsed.room_id ? { room_id: parsed.room_id } : {}),
      ...(parsed.env_slots.length ? { env_slots: parsed.env_slots } : {}),
      files: files.map(f => f.path),
      ...(includeContent ? { content: raw } : {}),
    };
  }

  list({ lookupBot = null } = {}) {
    const root = capabilitiesDataRoot(this.dataRoot);
    if (!existsSync(root)) return [];
    const bundledSet = this.bundledIds();
    const items = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
      const item = this.readEntry(entry.name, { includeContent: false, lookupBot, bundledSet });
      if (item) items.push(item);
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id, { lookupBot = null } = {}) {
    if (typeof id !== 'string' || !safeId.test(id)) {
      reject('capability_not_found', 'Capability not found', 404);
    }
    const found = this.readEntry(id, { includeContent: true, lookupBot });
    if (!found) reject('capability_not_found', `Capability "${id}" not found`, 404);
    return found;
  }

  readFile(id, relPath) {
    this.get(id);
    const clean = validateCapabilityRelPath(relPath);
    const root = capabilityRootDir(this.dataRoot, id);
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes capability folder');
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      reject('file_not_found', `Capability file not found: ${clean}`, 404);
    }
    const content = readFileSync(abs, 'utf8');
    return { path: clean, content, size: Buffer.byteLength(content, 'utf8') };
  }

  writeFile(id, relPath, content) {
    const clean = validateCapabilityRelPath(relPath);
    if (typeof content !== 'string' || content.length > 512_000 || content.includes('\0')) {
      reject('invalid_content', 'Capability file must be UTF-8 text up to 512 KB');
    }
    const root = capabilityRootDir(this.dataRoot, id);
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes capability folder');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return { path: clean, size: Buffer.byteLength(content, 'utf8') };
  }
}
