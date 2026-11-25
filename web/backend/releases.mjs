import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { githubBase, releaseTag, releaseTargets, validateRelease, validTarget } from './release-meta.mjs';
import { openPublishedFile } from './game-exports.mjs';

const prefix = '/api/releases';
const sendJson = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};

export async function readCurrentRelease(root, platform, arch) {
  if (!root || !validTarget(platform, arch)) return null;
  let record;
  try { record = JSON.parse(await readFile(join(root, platform, arch, 'current.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.platform !== platform || record.arch !== arch || typeof record.directory !== 'string'
    || !/^release-[A-Za-z0-9._-]+$/.test(record.directory) || record.directory.endsWith('.')) {
    throw new Error('Invalid client release metadata');
  }
  return { ...validateRelease(record), directory: record.directory, publishedAt: record.publishedAt };
}

const publicRelease = record => {
  const { directory, ...value } = record;
  const base = `${prefix}/${record.platform}/${record.arch}/`;
  return { ...value, source: 'local', downloadUrl: `${base}${encodeURIComponent(record.mainFile)}`,
    files: record.files.map(file => ({ ...file, url: `${base}${encodeURIComponent(file.name)}` })) };
};

const githubCache = new Map();
const githubOptions = () => ({
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Summon-Bot' }, signal: AbortSignal.timeout(15000),
});
async function githubRelease(repository, platform, arch) {
  const base = githubBase(repository, platform, arch), tag = releaseTag(platform, arch);
  const cached = githubCache.get(base);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, githubOptions());
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 版本信息暂时不可用（HTTP ${response.status}）`);
    const release = await response.json();
    if (release.draft || release.tag_name !== tag) return null;
    const manifest = await fetch(`${base}latest.json`, { signal: AbortSignal.timeout(15000) });
    if (!manifest.ok) throw new Error(`GitHub 版本信息暂时不可用（HTTP ${manifest.status}）`);
    const metadata = validateRelease(await manifest.json());
    if (metadata.platform !== platform || metadata.arch !== arch) throw new Error('GitHub client release target mismatch');
    return { ...metadata, source: 'github', publishedAt: release.published_at,
      downloadUrl: `${base}${encodeURIComponent(metadata.mainFile)}`,
      files: metadata.files.map(file => ({ ...file, url: `${base}${encodeURIComponent(file.name)}` })) };
  })();
  githubCache.set(base, { promise, expires: Date.now() + 120000 });
  try { return await promise; }
  catch (error) {
    if (githubCache.get(base)?.promise === promise) githubCache.delete(base);
    throw error;
  }
}

export async function serveClientReleases(req, res, url, root, webRelease, { local, origin }) {
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  if (local && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  }
  if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: '只支持查询和下载' }); return true; }
  const localOnly = url.searchParams.get('local') === '1';
  if (localOnly && !local) { sendJson(res, 404, { error: '仅本机可查询本机发行物' }); return true; }
  if ([prefix, `${prefix}/`].includes(url.pathname)) {
    const targets = await Promise.all(releaseTargets.map(async ([platform, arch]) => {
      const result = { target: `${platform}/${arch}` };
      if (local) {
        try {
          const record = await readCurrentRelease(root, platform, arch);
          if (record) return { ...result, record: publicRelease(record) };
        } catch { result.localError = '本机发行元数据无法读取'; }
      }
      if (!localOnly) {
        try { result.record = await githubRelease(webRelease.githubRepository, platform, arch); }
        catch (error) { result.githubError = error.message; }
      }
      return result;
    }));
    const githubError = targets.filter(item => item.githubError).map(item => `${item.target} ${item.githubError}`).join(' · ');
    const localError = targets.filter(item => item.localError).map(item => `${item.target} ${item.localError}`).join(' · ');
    sendJson(res, 200, { web: webRelease, githubRepository: webRelease.githubRepository, githubError,
      localError, releases: targets.flatMap(item => item.record ? [item.record] : []) }); return true;
  }
  const match = url.pathname.match(/^\/api\/releases\/([a-z]+)\/([a-z0-9]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match || !validTarget(match[1], match[2])) { sendJson(res, 404, { error: '没有此平台的发行包' }); return true; }
  const [, platform, arch, name] = match;
  if (!local) {
    try {
      const record = await githubRelease(webRelease.githubRepository, platform, arch);
      if (!record) { sendJson(res, 404, { error: '此平台尚未发布' }); return true; }
      if (name === 'latest.json') { sendJson(res, 200, record); return true; }
      const file = record.files.find(file => file.name === name);
      if (!file) { sendJson(res, 404, { error: '发行文件不存在，请重新检查更新' }); return true; }
      res.writeHead(302, { Location: file.url, 'Cache-Control': 'no-store' }); res.end(); return true;
    } catch (error) { sendJson(res, 502, { error: error.message }); return true; }
  }
  let record;
  try { record = await readCurrentRelease(root, platform, arch); }
  catch { sendJson(res, 502, { error: '本机发行元数据无法读取' }); return true; }
  if (!record) { sendJson(res, 404, { error: '此平台尚未发布' }); return true; }
  if (name === 'latest.json') { sendJson(res, 200, publicRelease(record)); return true; }
  if (!record.files.some(file => file.name === name)) { sendJson(res, 404, { error: '发行文件不存在，请重新检查更新' }); return true; }
  const asset = await openPublishedFile(resolve(root, platform, arch, record.directory, name));
  if (!asset) {
    sendJson(res, 404, { error: '发行包已替换，请重新检查更新' }); return true;
  }
  try {
    const { file, size } = asset;
    let start = 0, end = size - 1, partial = false;
    if (req.headers.range) {
      const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true; }
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true;
      }
      partial = true;
    }
    const mime = name.endsWith('.apk') ? 'application/vnd.android.package-archive'
      : name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream';
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      ...(!name.endsWith('.yml') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
    });
    if (req.method === 'HEAD' || !size) res.end();
    else await pipeline(file.createReadStream({ start, end }), res).catch(error => { if (!res.destroyed) res.destroy(error); });
    return true;
  } finally { await asset.file.close(); }
}
