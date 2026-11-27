import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, resolve, sep } from 'node:path';
import { reject } from '../platform/contract.mjs';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const textExts = new Set(['.md', '.txt', '.json', '.mjs', '.js', '.cjs', '.ts', '.py', '.sh', '.ps1', '.yaml', '.yml', '.toml']);

/** Single source of truth for protected Summon host directories (never writable as workspace/exec cwd). */
export function protectedRuntimeDirs(dataRoot, releaseRoot) {
  const root = resolve(dataRoot);
  const rel = resolve(releaseRoot);
  const installRoot = basename(dirname(rel)) === 'releases'
    ? dirname(dirname(rel))
    : basename(rel) === 'summon-runtime'
      ? dirname(rel)
      : rel;
  const dataProtected = ['config', 'capabilities', 'bots', 'engines', 'skills', 'knowledge', 'web', 'connectors', 'client-releases', 'history.json', 'installation.json', 'host-profile.md']
    .map(name => join(root, name));
  return [...dataProtected, installRoot];
}

export function hostProfilePath(dataRoot) {
  return join(resolve(dataRoot), 'host-profile.md');
}

export function readHostProfile(dataRoot) {
  const file = hostProfilePath(dataRoot);
  try {
    if (!existsSync(file)) return { content: '', updated_at: null, size: 0 };
    const info = statSync(file);
    if (!info.isFile()) return { content: '', updated_at: null, size: 0 };
    const content = readFileSync(file, 'utf8');
    return { content, updated_at: info.mtime.toISOString(), size: Buffer.byteLength(content, 'utf8') };
  } catch {
    return { content: '', updated_at: null, size: 0 };
  }
}

export function writeHostProfile(dataRoot, content) {
  if (typeof content !== 'string' || content.length > 8192 || content.includes('\0')) {
    reject('invalid_content', 'Host profile must be UTF-8 text of at most 8192 characters');
  }
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const file = hostProfilePath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, normalized ? `${normalized}\n` : '', 'utf8');
  const info = statSync(file);
  return { content: normalized, updated_at: info.mtime.toISOString(), size: Buffer.byteLength(normalized, 'utf8') };
}

export function botRootDir(dataRoot, botId) {
  if (!safeId.test(botId)) reject('invalid_identity', 'Invalid Bot ID');
  return join(resolve(dataRoot), 'bots', botId);
}

export function botLocalDir(dataRoot, botId) {
  return join(botRootDir(dataRoot, botId), '.local');
}

export function botStateDbPath(dataRoot, botId) {
  return join(botLocalDir(dataRoot, botId), 'state.sqlite');
}

export function validateBotRelPath(relPath, { allowLocalState = false } = {}) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > 300 || /[\\:\0\p{Cc}]/u.test(relPath)) {
    reject('invalid_path', 'Use a safe relative POSIX path inside the Bot folder');
  }
  const clean = relPath.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) reject('invalid_path', 'Use a safe relative POSIX path inside the Bot folder');
  const parts = clean.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    reject('invalid_path', 'Path cannot traverse outside the Bot folder');
  }
  if (!allowLocalState && parts[0] === '.local' && parts[1]?.startsWith('state.sqlite')) {
    reject('invalid_path', 'Cannot directly access Bot runtime database');
  }
  return clean;
}

export function ensureBotFolder(dataRoot, bot) {
  const root = botRootDir(dataRoot, bot.id);
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.local', 'memory'), { recursive: true });
  syncBotMetaFiles(dataRoot, bot);
  return root;
}

export function syncBotMetaFiles(dataRoot, bot) {
  const root = botRootDir(dataRoot, bot.id);
  mkdirSync(root, { recursive: true });
  const meta = {
    id: bot.id,
    name: bot.name,
    public_duty: bot.public_duty || '',
    ...(bot.built_in_role?.id ? { role_id: bot.built_in_role.id } : {}),
    ...(bot.bundled_id ? { bundled_id: bot.bundled_id } : {}),
    ...(bot.model_provider ? { model_provider: bot.model_provider } : {}),
    ...(bot.avatar ? { avatar: bot.avatar } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    env_slots: Array.isArray(bot.env_slots) ? bot.env_slots : [],
  };
  writeFileSync(join(root, 'bot.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  if (typeof bot.instructions === 'string') {
    writeFileSync(join(root, 'instructions.md'), bot.instructions, 'utf8');
  }
}

export function readBotFolderMeta(dataRoot, botId) {
  const file = join(botRootDir(dataRoot, botId), 'bot.json');
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return null;
}

export function readBotInstructions(dataRoot, bot) {
  const file = join(botRootDir(dataRoot, bot.id), 'instructions.md');
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  } catch {}
  return bot.instructions || '';
}

function walkRelativeFiles(baseDir, prefix = '', out = []) {
  if (!existsSync(baseDir)) return out;
  for (const entry of readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (prefix === '.local' && entry.name.startsWith('state.sqlite')) continue;
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

export function listBotFolderFiles(dataRoot, botId) {
  const root = botRootDir(dataRoot, botId);
  if (!existsSync(root)) return [];
  return walkRelativeFiles(root);
}

export function readBotFolderFile(dataRoot, botId, relPath, { allowDirectory = false } = {}) {
  const clean = validateBotRelPath(relPath);
  const root = botRootDir(dataRoot, botId);
  const abs = resolve(root, clean);
  if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes Bot folder');
  if (!existsSync(abs)) reject('file_not_found', `Bot file not found: ${clean}`, 404);
  const info = statSync(abs);
  if (info.isDirectory()) {
    if (!allowDirectory) reject('file_not_found', `Bot file not found: ${clean}`, 404);
    const entries = walkRelativeFiles(abs, clean);
    return {
      path: clean,
      kind: 'directory',
      entries,
      ...(clean === '.local/memory' ? { memory_items: listBotMemoryItems(dataRoot, botId) } : {}),
    };
  }
  if (!info.isFile()) reject('file_not_found', `Bot file not found: ${clean}`, 404);
  const content = readFileSync(abs, 'utf8');
  return { path: clean, content, size: Buffer.byteLength(content, 'utf8') };
}

export function writeBotFolderFile(dataRoot, botId, relPath, content) {
  const clean = validateBotRelPath(relPath);
  if (typeof content !== 'string' || content.length > 512_000 || content.includes('\0')) {
    reject('invalid_content', 'Bot folder file must be UTF-8 text up to 512 KB');
  }
  const root = botRootDir(dataRoot, botId);
  const abs = resolve(root, clean);
  if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes Bot folder');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return { path: clean, size: Buffer.byteLength(content, 'utf8') };
}

export function collectBotContextBundle(dataRoot, botId) {
  const root = botRootDir(dataRoot, botId);
  const readDirText = (subDir, maxFiles = 20, maxBytesPerFile = 24_000) => {
    const dir = join(root, subDir);
    if (!existsSync(dir)) return [];
    const items = [];
    for (const file of walkRelativeFiles(dir).slice(0, maxFiles)) {
      if (!textExts.has(extname(file.path).toLowerCase())) continue;
      try {
        const text = readFileSync(join(dir, file.path), 'utf8').trim();
        if (text) items.push({ path: posix.join(subDir.replaceAll('\\', '/'), file.path), content: text.slice(0, maxBytesPerFile), updated_at: file.updated_at });
      } catch {}
    }
    return items;
  };
  const scriptsDir = join(root, 'scripts');
  const scripts = existsSync(scriptsDir) ? walkRelativeFiles(scriptsDir).map(f => posix.join('scripts', f.path)) : [];
  return {
    skills: readDirText('skills'),
    privateMemory: readDirText(join('.local', 'memory')),
    scripts,
  };
}

export function listBotMemoryItems(dataRoot, botId) {
  const { privateMemory } = collectBotContextBundle(dataRoot, botId);
  return privateMemory.map(entry => ({
    id: entry.path,
    item_id: entry.path.replace(/^\.local\/memory\//, ''),
    path: entry.path,
    note: entry.content,
    applies_to: [{ kind: 'bot', id: botId }],
    updated_at: entry.updated_at,
  }));
}

export function bundledBotsRoot(releaseRoot) {
  return join(resolve(releaseRoot), 'bundled-bots');
}

export function listBundledBots(releaseRoot) {
  const root = bundledBotsRoot(releaseRoot);
  if (!existsSync(root)) return [];
  const items = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const metaFile = join(dir, 'bot.json');
    if (!existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      const instructions = existsSync(join(dir, 'instructions.md')) ? readFileSync(join(dir, 'instructions.md'), 'utf8') : '';
      const skills = walkRelativeFiles(join(dir, 'skills')).map(f => posix.join('skills', f.path));
      const scripts = walkRelativeFiles(join(dir, 'scripts')).map(f => posix.join('scripts', f.path));
      items.push({
        id: meta.id || entry.name,
        name: meta.name || entry.name,
        role_id: meta.role_id || 'default',
        public_duty: meta.public_duty || '',
        model_provider: meta.model_provider || null,
        env_slots: Array.isArray(meta.env_slots) ? meta.env_slots : [],
        instructions,
        skills,
        scripts,
        dir,
      });
    } catch {}
  }
  return items;
}

export function previewBundledBot(releaseRoot, bundledId) {
  const pkg = listBundledBots(releaseRoot).find(item => item.id === bundledId);
  if (!pkg) reject('bundled_bot_not_found', `Unknown bundled Bot: ${bundledId}`, 404);
  const readList = paths => paths.map(rel => {
    const abs = join(pkg.dir, rel);
    let content = '';
    try { content = readFileSync(abs, 'utf8'); } catch {}
    return { path: rel, content };
  });
  return {
    id: pkg.id,
    name: pkg.name,
    role_id: pkg.role_id,
    public_duty: pkg.public_duty,
    model_provider: pkg.model_provider,
    env_slots: pkg.env_slots,
    instructions: pkg.instructions,
    skills: readList(pkg.skills),
    scripts: readList(pkg.scripts),
  };
}

export function installBundledBotFiles(releaseRoot, dataRoot, bundledId, targetBotId) {
  const pkg = listBundledBots(releaseRoot).find(item => item.id === bundledId);
  if (!pkg) reject('bundled_bot_not_found', `Unknown bundled Bot: ${bundledId}`, 404);
  const targetDir = botRootDir(dataRoot, targetBotId);
  mkdirSync(join(targetDir, 'skills'), { recursive: true });
  mkdirSync(join(targetDir, 'scripts'), { recursive: true });
  mkdirSync(join(targetDir, '.local', 'memory'), { recursive: true });
  for (const name of ['skills', 'scripts']) {
    const src = join(pkg.dir, name);
    if (existsSync(src)) cpSync(src, join(targetDir, name), { recursive: true, force: true });
  }
  if (existsSync(join(pkg.dir, 'instructions.md'))) {
    writeFileSync(join(targetDir, 'instructions.md'), pkg.instructions, 'utf8');
  }
  return pkg;
}
