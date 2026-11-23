import { lstat, open, readdir } from 'node:fs/promises';
import { closeSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { createAuthorizedDirectory, createPathAccess, samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { documentText } from '../chatroom/document-text.mjs';
import { rasterType } from '../chatroom/attachments.mjs';
import { assertRevision, keyOf, reject, sameRef } from '../platform/contract.mjs';

export const files = 'platform-files';
export const fileRevisions = 'platform-file-revisions';
const maximumFileBytes = 20 * 1024 * 1024;

function rejectFileSize(size) {
  reject('file_too_large', `File exceeds the storage size limit of ${maximumFileBytes} bytes`, 413,
    { max_bytes: maximumFileBytes, size_bytes: size });
}

function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\:\p{Cc}]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    reject('invalid_path', 'File path must be a relative path within its space');
  }
  return value;
}

export class Files {
  constructor({ store, room, attachments, canReadSpace, canWriteSpace, canReadReference, assertShareable, notify }) {
    Object.assign(this, { store, room, attachments, canReadSpace, canWriteSpace, canReadReference, assertShareable, notify });
  }

  get(id) { return this.store.get(files, id); }

  async collectWorkspaceFile(source, path, workspace, protectedDirectories) {
    const name = filePath(path);
    const checkPath = createPathAccess({ workspace: workspace.root, projectOnly: true, protectedDirectories, accessPolicy: workspace.path_policy });
    let checked;
    try { checked = await checkPath(name, { file: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) reject('file_not_found', 'Workspace file is unavailable', 404);
      throw error;
    }
    const handle = await open(checked, 'r');
    try {
      const size = await handle.stat();
      if (!size.isFile() || size.size > maximumFileBytes) rejectFileSize(size.size);
      const actual = await checkPath(name, { file: true });
      const verified = await lstat(actual);
      if (!verified.isFile() || size.nlink !== 1 || verified.ino !== size.ino || verified.dev !== size.dev || !samePath(actual, checked)) {
        reject('file_source_changed', 'The workspace file changed while it was opened', 409);
      }
      const bytes = Buffer.alloc(size.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const confirmed = await handle.stat();
      if (offset !== bytes.length || confirmed.size !== size.size || confirmed.mtimeMs !== size.mtimeMs) {
        reject('file_source_changed', 'The workspace file changed during reading', 409);
      }
      return { bytes, root: workspace.root, source, path: name, revision: Math.round(confirmed.mtimeMs * 1000) };
    } finally { await handle.close(); }
  }

  async readWorkspace(args, workspace, protectedDirectories, authorize) {
    const file = await this.collectWorkspaceFile(args.ref, args.path, workspace, protectedDirectories);
    authorize();
    const projection = { ref: args.ref, path: file.path, revision: file.revision, size: file.bytes.length };
    let content;
    if (!file.bytes.includes(0)) {
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); } catch { content = undefined; }
    }
    return this.pageText(projection, content, args.cursor, args.limit);
  }

  async listWorkspace({ ref, directory = '.', query, cursor, limit = 50 }, workspace, protectedDirectories, authorize) {
    const relative = directory === '.' ? '.' : filePath(directory);
    const check = createPathAccess({ workspace: workspace.root, projectOnly: true, protectedDirectories, accessPolicy: workspace.path_policy });
    const target = await check(relative, { directory: true, operations: ['read'] });
    const names = (await readdir(target, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isFile())
      .map(entry => entry.name).filter(name => !query || name.toLowerCase().includes(query.trim().toLowerCase())).sort();
    const items = [];
    let more = false;
    for (const name of names) {
      const path = relative === '.' ? name : posix.join(relative, name);
      if (cursor && path <= cursor) continue;
      try {
        filePath(path);
        const checked = await check(path, { operations: ['read'] });
        const info = await lstat(checked);
        if (!samePath(checked, join(target, name)) || !info.isDirectory() && !(info.isFile() && info.nlink === 1)) continue;
        if (items.length === limit) { more = true; break; }
        items.push({ name, path, kind: info.isDirectory() ? 'directory' : 'file', read: info.isDirectory() ? { ref, directory: path } : { ref, path } });
      } catch (error) {
        if (error.status === 400 || error.status === 403 || ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
    }
    authorize();
    if (!samePath(target, await check(relative, { directory: true, operations: ['read'] }))) reject('workspace_changed', 'Project directory changed while listing', 409);
    return { ref, directory: relative, items, next_cursor: more ? items.at(-1).path : null };
  }

  async prepareWorkspaceWrite(args, content, workspace, protectedDirectories, authorize) {
    const path = filePath(args.path);
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) reject('invalid_arguments', 'Supply text or a File source to write a project file');
    const size = Buffer.byteLength(content);
    if (size > maximumFileBytes) rejectFileSize(size);
    const check = createPathAccess({ workspace: workspace.root, projectOnly: true, protectedDirectories, accessPolicy: workspace.path_policy });
    const target = await createAuthorizedDirectory(path, (name, options) => {
      authorize();
      return check(name, options);
    }, { parentOfFile: true });
    // Commit the checked replacement synchronously with the call receipt and live Room authorization.
    return () => {
      authorize();
      const parent = dirname(target);
      if (!samePath(realpathSync(parent), parent) || !samePath(join(workspace.root, path), target))
        reject('workspace_changed', 'Project file location has changed', 409);
      const before = lstatSync(target, { throwIfNoEntry: false });
      if (before && (!before.isFile() || before.nlink !== 1)) reject('file_write_forbidden', 'Select a regular project file', 403);
      if (args.revision !== undefined) assertRevision(before ? Math.round(before.mtimeMs * 1000) : null, args.revision);
      const temporary = join(parent, '.summon-' + randomUUID() + '.tmp');
      const fd = openSync(temporary, 'wx', before?.mode ?? 0o600);
      let committed = false;
      try {
        try { writeFileSync(fd, content); } finally { closeSync(fd); }
        renameSync(temporary, target);
        committed = true;
        return { ref: args.space, path, size, revision: Math.round(lstatSync(target).mtimeMs * 1000) };
      } finally { if (!committed) unlinkSync(temporary); }
    };
  }

  list(context, scope) {
    return this.store.list(files).filter(file => (!scope || sameRef(file.space, scope)) && this.canRead(file.id, context)).map(file => this.view(file, context));
  }

  canRead(id, context) {
    const file = this.get(id);
    if (file) {
      if (context.actor?.kind === 'user' && file.space?.kind === 'room' && !this.store.get('rooms', file.space.id) &&
          this.store.get('deleted-rooms', file.space.id)) return true;
      if (this.canReadSpace(context.actor, file.space)) return true;
      if (file.shared_rooms?.some(roomId => this.canReadSpace(context.actor, { kind: 'room', id: roomId }))) return true;
      return false;
    }
    try {
      this.room.attachment(id, context.actor.id);
      return true;
    } catch (error) {
      if ([403, 404].includes(error.status)) return false;
      throw error;
    }
  }

  projectSources(sources, context) {
    if (!Array.isArray(sources)) return [];
    if (!context) return sources;
    return sources.map(ref => {
      try {
        return this.canReadReference(ref, context) ? ref : { kind: ref.kind, id: ref.id, access: 'redacted' };
      } catch {
        return { kind: ref?.kind || 'event', id: ref?.id || '', access: 'redacted' };
      }
    });
  }

  listRevisions(id, context) {
    return this.store.list(fileRevisions)
      .filter(rev => (rev.file_id === id || rev.id?.startsWith(JSON.stringify([id]).slice(0, -1))) && Number.isSafeInteger(rev.revision))
      .sort((a, b) => b.revision - a.revision)
      .map(rev => ({
        revision: rev.revision,
        size: rev.size,
        author: rev.author,
        sources: this.projectSources(rev.sources, context),
        call_id: rev.call_id || null,
        updated_at: rev.updatedAt || rev.createdAt || null,
      }));
  }

  view(file, context = null, latestRevision = undefined) {
    const { id, space, path, revision, size, author, sources, createdAt, updatedAt } = file;
    const deletedRoom = space?.kind === 'room' && !this.store.get('rooms', space.id) && Boolean(this.store.get('deleted-rooms', space.id));
    const isHistorical = latestRevision !== undefined && latestRevision !== revision;
    const url = `/api/files/${encodeURIComponent(id)}/download${isHistorical ? `?revision=${revision}` : ''}`;
    return { kind: 'file', id, ref: { kind: 'file', id }, name: posix.basename(path), path, space, revision,
      ...(isHistorical ? { latest_revision: latestRevision } : {}),
      size, author, sources: this.projectSources(sources, context),
      ...(deletedRoom ? { deleted_room: true } : {}),
      created_at: createdAt, updated_at: updatedAt, url };
  }

  getProjection(id, context, revision = undefined) {
    if (!this.canRead(id, context)) reject('file_not_found', 'File is unavailable', 404);
    const current = this.get(id);
    if (current) {
      let target = current;
      if (revision !== undefined && revision !== current.revision) {
        const snapshot = this.store.get(fileRevisions, keyOf(id, revision));
        if (!snapshot) reject('file_revision_not_found', `Revision ${revision} of this File is unavailable`, 404);
        target = { ...current, ...snapshot, id: current.id, revision: snapshot.revision };
      }
      const revisions = this.listRevisions(id, context);
      return { file: target, projection: { ...this.view(target, context, current.revision), ...(revisions.length ? { revisions } : {}) } };
    }
    if (revision !== undefined && revision !== 1) reject('file_revision_not_found', `Revision ${revision} of this File is unavailable`, 404);
    const attachment = this.attachments.project(this.room.attachment(id, context.actor.id));
    return { file: current, projection: { ...attachment, kind: 'file', id, ref: { kind: 'file', id }, revision: 1 } };
  }

  read(id, context, cursor, limit, revision = undefined) {
    const { file, projection } = this.getProjection(id, context, revision);
    return this.pageText(projection, file?.content, cursor, limit);
  }

  async readObject(id, context, cursor, limit, revision = undefined) {
    const { file, projection } = this.getProjection(id, context, revision);
    if (file && !file.attachment_id && file.blob == null) return this.pageText(projection, file.content, cursor, limit);
    if (context.imageInput) {
      const attachment = file?.attachment_id ? this.attachments.get(file.attachment_id) : projection;
      const mimeType = file?.blob != null ? rasterType(Buffer.from(file.blob.slice(0, 64), 'base64'))
        : attachment.previewUrl && attachment.mimeType;
      if (mimeType) {
        if (cursor != null) reject('file_text_unavailable', 'Images do not have a text cursor', 409);
        const { supported, maxBytes } = context.imageInput;
        const encodedSize = 4 * Math.ceil(projection.size / 3);
        const status = !supported ? 'image_input_unsupported' : maxBytes && encodedSize > maxBytes ? 'image_too_large' : 'image';
        return { ...projection, mimeType, content_status: status, next_cursor: null,
          ...(status === 'image_input_unsupported' && { message: '当前用途绑定的模型连接未声明可用的图像输入，只能读取附件信息。' }),
          ...(status === 'image_too_large' && { message: `此图编码后超过当前模型的图像输入上限（${maxBytes} 字节）。可提供较小的图片。` }) };
      }
    }
    let content;
    try {
      content = file?.blob != null ? documentText(projection.name, Buffer.from(file.blob, 'base64'))
        : await this.attachments.text(file?.attachment_id || id);
    }
    catch (error) {
      if (error.status && error.status !== 404) throw error;
      if (cursor != null) reject('file_text_unavailable', 'This File has no available text projection', 409);
      return { ...projection, content_status: error.status === 404 ? 'unavailable' : 'unsupported', next_cursor: null };
    }
    if (!this.canRead(id, context)) reject('file_not_found', 'File is unavailable', 404);
    return this.pageText(projection, content, cursor, limit);
  }

  async modelImage(result, context) {
    const { file, projection } = this.getProjection(result.id, context);
    if (projection.revision !== result.revision) reject('file_changed', 'Read the new File revision before viewing its image', 409);
    const bytes = file?.blob != null ? Buffer.from(file.blob, 'base64')
      : (await this.attachments.read(file?.attachment_id || result.id, true)).bytes;
    if (!this.canRead(result.id, context)) reject('file_not_found', 'File is unavailable', 404);
    if (rasterType(bytes) !== result.mimeType) reject('file_changed', 'The original image is unavailable', 409);
    return { type: 'image', mimeType: result.mimeType, data: bytes.toString('base64') };
  }

  pageText(projection, content, cursor, limit) {
    if (typeof content !== 'string') return { ...projection, content_status: 'unavailable', next_cursor: null };
    const start = cursor == null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0 || start > content.length) reject('cursor_expired', 'Invalid File read offset', 409);
    const maximum = (limit ?? 50) * 2000;
    const part = content.slice(start, start + maximum);
    return { ...projection, content: part, next_cursor: start + part.length < content.length ? String(start + part.length) : null };
  }

  save(args, context, callId, collected) {
    const { space } = args;
    const path = filePath(args.path);
    if (!this.canWriteSpace(context.actor, space, context)) reject('file_write_forbidden', 'File space is unavailable for writing', 403);
    const before = this.store.list(files).find(file => sameRef(file.space, space) && file.path === path);
    if (before) {
      if (!this.canRead(before.id, context)) reject('file_write_forbidden', 'File is outside the execution’s resource scope', 403);
      assertRevision(before.revision, args.revision);
    } else if (args.revision !== undefined) {
      assertRevision(null, args.revision);
    }
    const supplied = args.content_or_source;
    const source = typeof supplied === 'object' ? supplied.source : null;
    const sources = [...new Map([...(args.sources || []), ...(source ? [source] : [])].map(ref => [keyOf(ref.kind, ref.id), ref])).values()];
    for (const ref of sources) {
      if (!this.canReadReference(ref, context)) reject('file_source_forbidden', 'File source reference is unavailable', 403);
    }
    let content = typeof supplied === 'string' ? supplied : supplied.text;
    let attachment_id = null, blob = null;
    let size;
    if (source) {
      if (source.kind === 'workspace') {
        if (!sameRef(source, collected?.source) || supplied.path !== collected.path) reject('workspace_forbidden', 'The workspace file was not collected', 403);
        blob = collected.bytes.toString('base64');
        size = collected.bytes.length;
        content = null;
      } else {
        if (space.kind === 'room') this.assertShareable(source, { actor: context.actor.id, room: this.room.room(space.id, context.actor.id), context });
        const original = this.get(source.id);
        const attachment = original?.attachment_id || (!original ? source.id : null);
        if (attachment) {
          attachment_id = attachment;
          size = this.attachments.get(attachment).size;
          content = null;
        } else {
          content = original.content;
          blob = original.blob ?? null;
          size = original.size;
        }
      }
    }
    if (typeof content === 'string') size = Buffer.byteLength(content);
    if (!Number.isSafeInteger(size) || size > maximumFileBytes) rejectFileSize(size);
    const id = before?.id || callId;
    const revision = (before?.revision || 0) + 1;
    const saved = this.store.save(files, { id, space, path, revision, size, author: context.actor, sources, content, attachment_id, blob,
      created_in: before?.created_in ?? (context.session ? { kind: 'session', id: context.session.id } : null), call_id: callId });
    this.store.save(fileRevisions, { ...saved, id: keyOf(id, revision), file_id: id });
    this.notify({ id: keyOf('file', id, revision), kind: 'event', type: 'file.revised', space, ref: { kind: 'file', id }, author: context.actor,
      previous_revision: before?.revision ?? null, revision, call_id: callId, time: new Date().toISOString() });
    return this.view(saved);
  }

  async download(id, context, revision = undefined) {
    const { file } = this.getProjection(id, context, revision);
    if (!file || file.attachment_id) {
      const value = await this.attachments.read(file?.attachment_id || id);
      if (!this.canRead(id, context)) reject('file_not_found', 'File is unavailable', 404);
      return value;
    }
    const bytes = file.blob == null ? Buffer.from(file.content, 'utf8') : Buffer.from(file.blob, 'base64');
    const name = encodeURIComponent(posix.basename(file.path)).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    return { bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
      'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${name}`, 'Content-Security-Policy': "sandbox; default-src 'none'" } };
  }
}
