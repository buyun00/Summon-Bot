import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, realpath, lstat, rename } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_REQUEST_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };

function rasterType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Original uploads are kept outside Bot workspaces. Only server-issued IDs enter messages. */
export class AttachmentStore {
  constructor(dataDir) { this.root = resolve(dataDir, 'attachments'); }

  directory(id) {
    if (typeof id !== 'string' || !validId.test(id)) fail('附件编号无效', 404);
    return join(this.root, id);
  }

  async upload(input) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 240 || /[\\/\x00-\x1f\x7f]/.test(input.name)) fail('附件文件名无效');
    if (typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) fail('附件不能超过 20 MB', 413);
    if (input.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.data) || input.data.slice(0, -2).includes('=')) fail('附件数据必须为有效的 Base64');
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.toString('base64') !== input.data) fail('附件数据必须为有效的 Base64');
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail('附件不能超过 20 MB', 413);
    const detected = rasterType(bytes);
    const declared = typeof input.mimeType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mimeType) ? input.mimeType.toLowerCase() : 'application/octet-stream';
    const id = randomUUID();
    const record = { id, name: input.name.trim(), mimeType: detected || declared, size: bytes.length,
      url: `/api/attachments/${id}`, ...(detected ? { previewUrl: `/api/attachments/${id}/preview` } : {}), createdAt: new Date().toISOString() };
    const directory = this.directory(id);
    await mkdir(this.root, { recursive: true });
    await mkdir(directory);
    try {
      await writeFile(join(directory, 'data'), bytes, { flag: 'wx' });
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(record), { flag: 'wx' });
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return record;
  }

  get(id) {
    const directory = this.directory(id);
    try {
      const record = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
      if (record.id !== id || !statSync(join(directory, 'data')).isFile()) fail('附件不存在', 404);
      return record;
    } catch (error) { if (error.status) throw error; fail('附件不存在，请重新选择文件', 404); }
  }

  resolve(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_MESSAGE_ATTACHMENTS) fail('每条消息最多附加 8 个文件');
    const ids = new Set();
    return input.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('附件格式无效');
      const record = this.get(item.id);
      if (ids.has(record.id)) fail('同一条消息不能重复附加同一个文件');
      ids.add(record.id);
      return record;
    });
  }

  async read(id, preview = false) {
    const record = this.get(id);
    if (preview && !record.previewUrl) fail('此附件不支持图片预览', 404);
    const bytes = await readFile(join(this.directory(id), 'data'));
    // Recheck the bytes before granting an inline type, including after a server restart.
    const mimeType = preview ? rasterType(bytes) : 'application/octet-stream';
    if (preview && !mimeType) fail('此附件不支持图片预览', 404);
    return { record, bytes, headers: {
      'Content-Type': mimeType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(record.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
    } };
  }

  async stageContext(context, workspace) {
    const references = [...(context.messages || []), context.trigger].filter(Boolean);
    const ids = [...new Set(references.flatMap(message => (message.attachments || []).map(item => item.id)))];
    if (!ids.length) return context;
    const directory = join(workspace, 'attachments');
    let directoryError;
    try {
      await mkdir(directory, { recursive: true });
      if (!within(await realpath(workspace), await realpath(directory))) fail('附件目录不在 Bot 工作区内');
    } catch (error) { directoryError = error; }
    const staged = new Map();
    for (const id of ids) {
      try {
      if (directoryError) throw directoryError;
      const record = this.get(id);
      const extension = extname(record.name).match(/^\.[a-z0-9]{1,12}$/i)?.[0] || '.bin';
      const path = join(directory, `${id}${extension}`);
      // A fresh temporary file and rename replace the directory entry, never a symlink target.
      const temp = join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        const previous = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (previous?.isDirectory()) fail('附件暂存路径被目录占用');
        await writeFile(temp, await readFile(join(this.directory(id), 'data')), { flag: 'wx' });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
      staged.set(id, { ...record, path, ...(record.mimeType.startsWith('image/') ? {
        modelNote: '当前模型仅接收文本，此图片只提供文件路径，尚未读取或理解图像内容；不能根据文件名猜测画面。',
      } : { modelNote: '附件已暂存到工作区；请用文件工具读取实际内容，不要仅凭文件名猜测。' }) });
      } catch (error) {
        const original = references.flatMap(message => message.attachments || []).find(item => item.id === id);
        staged.set(id, { ...original, path: undefined, unavailable: true,
          modelNote: `该附件暂时无法读取：${error.message}。保留原始引用，继续使用其他资料；明确依赖它的步骤须说明缺口。` });
      }
    }
    const decorate = message => message?.attachments?.length ? { ...message, attachments: message.attachments.map(item => staged.get(item.id)) } : message;
    return { ...context, messages: (context.messages || []).map(decorate), trigger: decorate(context.trigger) };
  }
}
