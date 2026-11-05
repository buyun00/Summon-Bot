import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { githubBase, releaseTag, releaseTargets, validTarget } from '../../scripts/release/targets.mjs';
import { validateRelease } from '../../scripts/release/repository.mjs';

const inside = (root, path) => { const part = relative(root, path); return part && !part.startsWith('..') && !isAbsolute(part); };
const prefix = '/api/releases';
const sendJson = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};

export async function readCurrentRelease(root, platform, arch, minimumBuildNumber) {
  if (!root || !validTarget(platform, arch)) return null;
  let record;
  try { record = JSON.parse(await readFile(join(root, platform, arch, 'current.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.buildNumber < minimumBuildNumber) return null;
  if (record.platform !== platform || record.arch !== arch || !/^release-[A-Za-z0-9._-]+$/.test(record.directory)
    || !Array.isArray(record.files) || record.files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name))) {
    throw new Error('Invalid client release metadata');
  }
  return record;
}

const publicRelease = record => {
  const { directory, ...value } = record;
  const base = `${prefix}/${record.platform}/${record.arch}/`;
  return { ...value, source: 'local', downloadUrl: `${base}${encodeURIComponent(record.mainFile)}`,
    files: record.files.map(file => ({ ...file, url: `${base}${encodeURIComponent(file.name)}` })) };
};

const githubCache = new Map();
async function githubReleases(repository) {
  const cached = githubCache.get(repository);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    // Release descriptions are for people; latest.json supplies the updater catalog.
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Summon-Bot' }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub 版本信息暂时不可用（HTTP ${response.status}）`);
    const releases = await response.json();
    return (await Promise.all(releaseTargets.map(async ([platform, arch]) => {
      const release = releases.find(item => !item.draft && item.tag_name === releaseTag(platform, arch));
      if (!release) return [];
      const base = githubBase(repository, platform, arch);
      const manifest = await fetch(`${base}latest.json`, { signal: AbortSignal.timeout(15000) });
      if (!manifest.ok) throw new Error(`GitHub 版本信息暂时不可用（HTTP ${manifest.status}）`);
      const metadata = validateRelease(await manifest.json());
      if (metadata.platform !== platform || metadata.arch !== arch) throw new Error('GitHub client release target mismatch');
      return [{ ...metadata, source: 'github', publishedAt: release.published_at,
        downloadUrl: `${base}${encodeURIComponent(metadata.mainFile)}`,
        files: metadata.files.map(file => ({ ...file, url: `${base}${encodeURIComponent(file.name)}` })) }];
    }))).flat();
  })();
  githubCache.set(repository, { promise, expires: Date.now() + 120000 });
  try { return await promise; }
  catch (error) { githubCache.delete(repository); throw error; }
}

export async function serveClientReleases(req, res, url, root, webRelease) {
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !req.headers['x-forwarded-host'] && !req.headers.forwarded;
  if (local && req.headers.origin === new URL(webRelease.appUrl).origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  }
  if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: '只支持查询和下载' }); return true; }
  const localOnly = url.searchParams.get('local') === '1';
  if (localOnly && !local) { sendJson(res, 404, { error: '仅本机可查询本机发行物' }); return true; }
  if ([prefix, `${prefix}/`].includes(url.pathname)) {
    const records = local ? (await Promise.all(releaseTargets.map(([platform, arch]) => readCurrentRelease(root, platform, arch, webRelease.buildNumber)))).filter(Boolean).map(publicRelease) : [];
    let remote = [], githubError = '';
    if (!localOnly) {
      try { remote = await githubReleases(webRelease.githubRepository); }
      catch (error) { githubError = error.message; }
    }
    sendJson(res, 200, { web: webRelease, githubRepository: webRelease.githubRepository, githubError,
      releases: [...records, ...remote.filter(item => !records.some(record => record.platform === item.platform && record.arch === item.arch))] }); return true;
  }
  const match = url.pathname.match(/^\/api\/releases\/([a-z]+)\/([a-z0-9]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match || !validTarget(match[1], match[2])) { sendJson(res, 404, { error: '没有此平台的发行包' }); return true; }
  const [, platform, arch, name] = match;
  if (!local) {
    try {
      const record = (await githubReleases(webRelease.githubRepository)).find(item => item.platform === platform && item.arch === arch);
      if (!record) { sendJson(res, 404, { error: '此平台尚未发布' }); return true; }
      if (name === 'latest.json') { sendJson(res, 200, record); return true; }
      const file = record.files.find(file => file.name === name);
      if (!file) { sendJson(res, 404, { error: '发行文件不存在，请重新检查更新' }); return true; }
      res.writeHead(302, { Location: file.url, 'Cache-Control': 'no-store' }); res.end(); return true;
    } catch (error) { sendJson(res, 502, { error: error.message }); return true; }
  }
  const record = await readCurrentRelease(root, platform, arch, webRelease.buildNumber);
  if (!record) { sendJson(res, 404, { error: '此平台尚未发布' }); return true; }
  if (name === 'latest.json') { sendJson(res, 200, publicRelease(record)); return true; }
  if (!record.files.some(file => file.name === name)) { sendJson(res, 404, { error: '发行文件不存在，请重新检查更新' }); return true; }
  const targetRoot = resolve(root, platform, arch);
  const path = join(targetRoot, record.directory, name);
  let info;
  try {
    const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)]);
    if (!inside(actualRoot, actualPath)) throw new Error('Release file outside repository');
    info = await stat(actualPath);
    if (!info.isFile()) throw new Error('Release file is not a file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sendJson(res, 404, { error: '发行包已替换，请重新检查更新' }); return true;
  }
  let start = 0, end = info.size - 1, partial = false;
  if (req.headers.range) {
    const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
    start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true;
    }
    partial = true;
  }
  const mime = name.endsWith('.apk') ? 'application/vnd.android.package-archive'
    : name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream';
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    ...(!name.endsWith('.yml') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
  });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(path, { start, end }), res).catch(error => { if (!res.destroyed) res.destroy(error); });
  return true;
}
