import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, posix, resolve, sep } from 'node:path';
import { reject } from '../platform/contract.mjs';

export const engineRecords = 'platform-engines';
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
const windows = process.platform === 'win32';
const DETECT_TTL_MS = 10_000;

export function extraToolDirs() {
  const home = homedir();
  const dirs = windows
    ? [
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'),
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
        join(home, '.grok', 'bin'), join(home, '.local', 'bin'),
        join(home, '.cargo', 'bin'), join(home, '.bun', 'bin'), join(home, 'scoop', 'shims'),
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'),
       join(home, '.cargo', 'bin'), join(home, '.bun', 'bin'), join(home, '.grok', 'bin')];
  return dirs.filter(d => existsSync(d));
}

function searchPathDirs() {
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const existing = (process.env[pathKey] || '').split(delimiter).filter(Boolean);
  return [...new Set([...existing, ...extraToolDirs()])];
}

export function detectHostCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const clean = command.trim();
  if (clean.includes('/') || clean.includes('\\')) {
    return existsSync(clean) && statSync(clean).isFile() ? clean : null;
  }
  const exts = windows
    ? [...new Set([...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '.exe', '.cmd', '.bat'])]
    : [''];
  for (const dir of searchPathDirs()) {
    for (const ext of exts) {
      const candidate = join(dir, windows && /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  if (windows && clean.toLowerCase() === 'codex') {
    const codexBinRoot = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      if (existsSync(codexBinRoot)) {
        for (const entry of readdirSync(codexBinRoot, { withFileTypes: true })) {
          const candidate = entry.isDirectory() ? join(codexBinRoot, entry.name, 'codex.exe') : join(codexBinRoot, entry.name);
          if (/codex\.exe$/i.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
      }
    } catch {}
  }
  return null;
}

export function enginesDataRoot(dataRoot) {
  return join(resolve(dataRoot), 'engines');
}

export function bundledEnginesRoot(releaseRoot) {
  return join(resolve(releaseRoot), 'bundled-engines');
}

export function engineRootDir(dataRoot, engineId) {
  if (typeof engineId !== 'string' || !safeId.test(engineId)) reject('invalid_engine', 'Invalid engine ID');
  return join(enginesDataRoot(dataRoot), engineId);
}

export function validateEngineRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > 300 || /[\\:\0\p{Cc}]/u.test(relPath)) {
    reject('invalid_path', 'Use a safe relative POSIX path inside the engine folder');
  }
  const clean = relPath.trim().replace(/^\/+/, '');
  const parts = clean.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    reject('invalid_path', 'Path cannot traverse outside the engine folder');
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

function readEngineMeta(dir, fallbackId) {
  const metaPath = join(dir, 'engine.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' && safeId.test(raw.id.trim()) ? raw.id.trim() : fallbackId;
    const script = typeof raw.script === 'string' && raw.script.trim() ? validateEngineRelPath(raw.script) : 'bridge.mjs';
    const envSlots = Array.isArray(raw.env_slots)
      ? [...new Set(raw.env_slots.filter(v => typeof v === 'string' && envNameRe.test(v)))]
      : [];
    return {
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
      command: typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : null,
      script,
      model_provider: typeof raw.model_provider === 'string' && raw.model_provider.trim() ? raw.model_provider.trim() : null,
      env_slots: envSlots,
    };
  } catch {
    return null;
  }
}

export class EngineManager {
  constructor({ store, dataRoot, releaseRoot }) {
    Object.assign(this, { store, dataRoot: resolve(dataRoot), releaseRoot: resolve(releaseRoot) });
    this.detectCache = new Map();
  }

  ensureDefaults() {
    const destRoot = enginesDataRoot(this.dataRoot);
    mkdirSync(destRoot, { recursive: true });
    const srcRoot = bundledEnginesRoot(this.releaseRoot);
    if (!existsSync(srcRoot)) return;
    for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
      const srcDir = join(srcRoot, entry.name);
      if (!existsSync(join(srcDir, 'engine.json'))) continue;
      const destDir = join(destRoot, entry.name);
      mkdirSync(destDir, { recursive: true });
      for (const file of walkRelativeFiles(srcDir)) {
        const destFile = join(destDir, ...file.path.split('/'));
        if (!existsSync(destFile)) {
          mkdirSync(dirname(destFile), { recursive: true });
          cpSync(join(srcDir, ...file.path.split('/')), destFile, { force: false });
        }
      }
    }
  }

  detectCommand(command, { fresh = false } = {}) {
    if (!command) return null;
    const now = Date.now();
    const cached = !fresh && this.detectCache.get(command);
    if (cached && now - cached.at < DETECT_TTL_MS) return cached.path;
    const found = detectHostCommand(command);
    this.detectCache.set(command, { path: found, at: now });
    return found;
  }

  hasScript(id, relScript) {
    try {
      const clean = validateEngineRelPath(relScript);
      const root = engineRootDir(this.dataRoot, id);
      const abs = resolve(root, clean);
      return abs.startsWith(root + sep) && existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  scriptPath(id, relScript) {
    const clean = validateEngineRelPath(relScript);
    const root = engineRootDir(this.dataRoot, id);
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
      reject('engine_script_not_found', `Engine script not found: ${id}/${clean}`, 404);
    }
    return abs;
  }

  list({ fresh = false } = {}) {
    const root = enginesDataRoot(this.dataRoot);
    if (!existsSync(root)) return [];
    const items = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
      const dir = join(root, entry.name);
      const meta = readEngineMeta(dir, entry.name);
      if (!meta) continue;
      const saved = this.store.get(engineRecords, meta.id);
      const detectedPath = this.detectCommand(meta.command, { fresh });
      const scriptReady = this.hasScript(meta.id, meta.script);
      const override = typeof saved?.enabled === 'boolean' ? saved.enabled : null;
      const enabled = override !== null ? override : Boolean(detectedPath);
      const available = Boolean(enabled && scriptReady);
      const files = walkRelativeFiles(dir);
      items.push({
        kind: 'engine',
        id: meta.id,
        name: meta.name,
        summary: meta.summary,
        command: meta.command,
        script: meta.script,
        model_provider: meta.model_provider,
        env_slots: meta.env_slots,
        installed: Boolean(detectedPath),
        detected_path: detectedPath,
        script_ready: scriptReady,
        enabled,
        enabled_override: override,
        available,
        files,
      });
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  available({ fresh = false } = {}) {
    return this.list({ fresh }).filter(item => item.available);
  }

  get(id, options = {}) {
    if (typeof id !== 'string' || !safeId.test(id)) reject('engine_not_found', 'Work engine not found', 404);
    const found = this.list(options).find(item => item.id === id);
    if (!found) reject('engine_not_found', `Work engine "${id}" not found`, 404);
    return found;
  }

  setEnabled(id, enabled) {
    const current = this.get(id);
    if (enabled !== null && typeof enabled !== 'boolean') {
      reject('invalid_arguments', 'enabled must be true, false, or null');
    }
    this.store.save(engineRecords, {
      id: current.id,
      enabled,
      updatedAt: new Date().toISOString(),
    });
    return this.get(current.id, { fresh: true });
  }

  listFiles(id) {
    this.get(id);
    return walkRelativeFiles(engineRootDir(this.dataRoot, id));
  }

  readFile(id, relPath) {
    this.get(id);
    const clean = validateEngineRelPath(relPath);
    const root = engineRootDir(this.dataRoot, id);
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes engine folder');
    if (!existsSync(abs) || !statSync(abs).isFile()) reject('file_not_found', `Engine file not found: ${clean}`, 404);
    const content = readFileSync(abs, 'utf8');
    return { path: clean, content, size: Buffer.byteLength(content, 'utf8') };
  }

  writeFile(id, relPath, content) {
    this.get(id);
    const clean = validateEngineRelPath(relPath);
    if (typeof content !== 'string' || content.length > 512_000 || content.includes('\0')) {
      reject('invalid_content', 'Engine file must be UTF-8 text up to 512 KB');
    }
    const root = engineRootDir(this.dataRoot, id);
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes engine folder');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return { path: clean, size: Buffer.byteLength(content, 'utf8') };
  }
}
