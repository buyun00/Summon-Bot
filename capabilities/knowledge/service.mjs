import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { reject } from '../platform/contract.mjs';

export function knowledgeDataRoot(dataRoot) {
  return join(resolve(dataRoot), 'knowledge');
}

export function validateKnowledgeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > 300 || /[\\:\0\p{Cc}]/u.test(relPath)) {
    reject('invalid_path', 'Use a safe relative POSIX path inside the shared knowledge folder');
  }
  const clean = relPath.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) reject('invalid_path', 'Specify a relative file path inside the shared knowledge folder');
  const parts = clean.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /^\.env(?:\.|$)/i.test(p))) {
    reject('invalid_path', 'Invalid or disallowed path inside the shared knowledge folder');
  }
  return clean;
}

function walkFiles(baseDir, prefix = '', out = []) {
  if (!existsSync(baseDir)) return out;
  for (const entry of readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const abs = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (entry.isFile()) {
      const info = statSync(abs);
      out.push({ path: rel, abs, size: info.size, updated_at: info.mtime.toISOString() });
    }
  }
  return out;
}

function summarizeFile(relPath, raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const heading = lines.find(l => l.startsWith('#'))?.replace(/^#+\s*/, '').trim();
  const title = heading || posix.basename(relPath, posix.extname(relPath));
  const summaryLines = lines
    .filter(l => !l.startsWith('#') && l !== '---')
    .slice(0, 3)
    .join(' ');
  const summary = summaryLines.slice(0, 220) || title;
  return { title, summary };
}

export class KnowledgeManager {
  constructor({ dataRoot }) {
    this.dataRoot = resolve(dataRoot);
  }

  dir() {
    return knowledgeDataRoot(this.dataRoot);
  }

  ensureRoot() {
    mkdirSync(this.dir(), { recursive: true });
  }

  exists(relPath) {
    try {
      const clean = validateKnowledgeRelPath(relPath);
      const root = this.dir();
      const abs = resolve(root, clean);
      return abs.startsWith(root + sep) && existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  list({ includeSnippet = false } = {}) {
    const root = this.dir();
    if (!existsSync(root)) return [];
    const items = [];
    for (const file of walkFiles(root)) {
      let raw = '';
      try {
        raw = file.size <= 512_000 ? readFileSync(file.abs, 'utf8') : readFileSync(file.abs, 'utf8').slice(0, 16_384);
      } catch {
        continue;
      }
      const { title, summary } = summarizeFile(file.path, raw);
      items.push({
        kind: 'knowledge',
        id: file.path,
        path: file.path,
        title,
        summary,
        size: file.size,
        updated_at: file.updated_at,
        ...(includeSnippet ? { _text: raw.slice(0, 16_384) } : {}),
      });
    }
    return items.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || a.id.localeCompare(b.id));
  }

  read(relPath) {
    const clean = validateKnowledgeRelPath(relPath);
    const root = this.dir();
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes shared knowledge folder');
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      reject('knowledge_not_found', `Shared knowledge file not found: ${clean}`, 404);
    }
    const info = statSync(abs);
    const content = readFileSync(abs, 'utf8');
    const { title, summary } = summarizeFile(clean, content);
    return {
      kind: 'knowledge',
      id: clean,
      path: clean,
      title,
      summary,
      content,
      size: info.size,
      updated_at: info.mtime.toISOString(),
    };
  }

  write(relPath, content) {
    const clean = validateKnowledgeRelPath(relPath);
    if (typeof content !== 'string' || content.length > 512_000 || content.includes('\0')) {
      reject('invalid_content', 'Knowledge file must be UTF-8 text up to 512 KB');
    }
    const root = this.dir();
    const abs = resolve(root, clean);
    if (!abs.startsWith(root + sep)) reject('invalid_path', 'Path escapes shared knowledge folder');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    const info = statSync(abs);
    const { title, summary } = summarizeFile(clean, content);
    return {
      kind: 'knowledge',
      id: clean,
      path: clean,
      title,
      summary,
      size: info.size,
      updated_at: info.mtime.toISOString(),
    };
  }
}
