import { createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publishRelease, removeInside, validateRelease } from '../../scripts/release/repository.mjs';

const prefix = '/api/releases/publish/';
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Release metadata too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createReleasePublisher(root, token) {
  const uploads = new Map();
  const incoming = join(root, '.incoming');
  await mkdir(incoming, { recursive: true });
  for (const entry of await readdir(incoming)) await removeInside(incoming, join(incoming, entry));
  return async (req, res, url) => {
    if (!url.pathname.startsWith(prefix)) return false;
    const expected = Buffer.from(`Bearer ${token || ''}`), actual = Buffer.from(req.headers.authorization || '');
    if (!token || actual.length !== expected.length || !timingSafeEqual(expected, actual)) { json(res, 401, { error: 'Unauthorized publication' }); return true; }
    let activeId;
    try {
      const path = url.pathname.slice(prefix.length).split('/');
      if (req.method === 'POST' && ['windows', 'macos', 'android'].includes(path[0]) && path.length === 2) {
        if (uploads.size >= 8) { json(res, 409, { error: 'Too many active uploads' }); return true; }
        const metadata = validateRelease(await readJson(req));
        if (metadata.platform !== path[0] || metadata.arch !== path[1]) throw new Error('Publication target mismatch');
        const id = randomUUID();
        const directory = join(incoming, id);
        await mkdir(directory);
        uploads.set(id, { metadata, directory, files: new Map(), busy: false });
        json(res, 201, { uploadId: id }); return true;
      }
      const [id, name] = path;
      const upload = path.length === 2 && uploads.get(id);
      if (!upload) { json(res, 404, { error: 'Unknown upload' }); return true; }
      if (upload.busy) { json(res, 409, { error: 'Upload operation already running' }); return true; }
      upload.busy = true; activeId = id;
      if (req.method === 'POST' && name === 'cancel') {
        await removeInside(incoming, upload.directory); uploads.delete(id);
        json(res, 200, { cancelled: true }); return true;
      }
      if (req.method === 'POST' && name === 'commit') {
        if (!upload.metadata.files.every(file => upload.files.get(file.name) === file.size)) throw new Error('Upload not complete');
        const result = await publishRelease(root, upload.directory, upload.metadata);
        await removeInside(incoming, upload.directory); uploads.delete(id);
        json(res, 200, { published: true, version: result.version, publishedAt: result.publishedAt }); return true;
      }
      const file = upload.metadata.files.find(file => file.name === name);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || '');
      if (req.method !== 'PUT' || !file || !range) throw new Error('Invalid package upload');
      const [, first, last, total] = range.map(Number);
      const length = last - first + 1;
      if (first !== (upload.files.get(name) || 0) || total !== file.size || last >= total || length < 1 || length > 8 * 1024 * 1024) throw new Error('Invalid package upload range');
      let received = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > length ? new Error('Upload chunk too large') : null, chunk);
      } });
      await pipeline(req, limit, createWriteStream(join(upload.directory, name), { flags: first === 0 ? 'wx' : 'a' }));
      if (received !== length) throw new Error('Upload chunk incomplete');
      upload.files.set(name, last + 1);
      json(res, 200, { received: last + 1 }); return true;
    } catch (error) {
      if (activeId && uploads.has(activeId)) {
        const upload = uploads.get(activeId); uploads.delete(activeId);
        await removeInside(incoming, upload.directory).catch(() => {});
      }
      if (!res.destroyed) json(res, 400, { error: error.message });
      return true;
    } finally { if (activeId && uploads.has(activeId)) uploads.get(activeId).busy = false; }
  };
}
