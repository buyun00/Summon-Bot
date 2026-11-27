import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_DISPLAY_NAME = '用户';
const jsonCache = new Map();

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

function readCachedJsonObject(filePath) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    jsonCache.delete(filePath);
    return null;
  }
  if (!st.isFile()) {
    jsonCache.delete(filePath);
    return null;
  }
  const cached = jsonCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data;
  }
  const data = readJsonObject(filePath);
  if (data !== null) {
    jsonCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, data });
  } else {
    jsonCache.delete(filePath);
  }
  return data;
}

function trimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function resolveDisplayName(profile, relay) {
  return (
    trimmedString(profile?.displayName) ||
    trimmedString(relay?.user?.displayName) ||
    trimmedString(relay?.user?.username) ||
    DEFAULT_DISPLAY_NAME
  );
}

function hasFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function readUserProfile(dataRoot) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) {
    return { displayName: DEFAULT_DISPLAY_NAME, avatarPath: null, avatarVersion: 0 };
  }
  const root = resolve(dataRoot);
  const profileFile = join(root, 'config', 'user-profile.json');
  const relayFile = join(root, 'config', 'relay.json');
  const avatarFile = join(root, 'config', 'user-avatar.jpg');

  const profile = readCachedJsonObject(profileFile);
  const relay = readCachedJsonObject(relayFile);

  const displayName = resolveDisplayName(profile, relay);

  const rawVersion = profile?.avatarVersion;
  const avatarVersion = Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : 0;
  const avatarPath = hasFile(avatarFile) ? `/api/user-profile/avatar?v=${avatarVersion}` : null;

  return { displayName, avatarPath, avatarVersion };
}

export function writeUserProfile(dataRoot, patch) {
  const root = resolve(dataRoot);
  const file = join(root, 'config', 'user-profile.json');
  const existing = readJsonObject(file) || {};
  const next = { ...existing };

  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    if (Object.hasOwn(patch, 'displayName') && typeof patch.displayName === 'string') {
      next.displayName = patch.displayName.trim();
    }
    if (Object.hasOwn(patch, 'avatarVersion') && Number.isSafeInteger(patch.avatarVersion) && patch.avatarVersion >= 0) {
      next.avatarVersion = patch.avatarVersion;
    }
  }

  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch {}
      throw error;
    }
  } finally {
    jsonCache.delete(file);
  }

  return readUserProfile(root);
}

export function userDisplayName(dataRoot) {
  try {
    if (typeof dataRoot !== 'string' || !dataRoot.trim()) return DEFAULT_DISPLAY_NAME;
    const root = resolve(dataRoot);
    const profile = readCachedJsonObject(join(root, 'config', 'user-profile.json'));
    const relay = readCachedJsonObject(join(root, 'config', 'relay.json'));
    return resolveDisplayName(profile, relay);
  } catch {
    return DEFAULT_DISPLAY_NAME;
  }
}
