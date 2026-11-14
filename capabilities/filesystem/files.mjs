import { lstat, open } from 'node:fs/promises';
import { posix } from 'node:path';
import { createPathAccess, samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { documentText } from '../chatroom/document-text.mjs';
import { assertRevision, keyOf, reject, sameRef } from '../platform/contract.mjs';

export const files = 'platform-files';
export const fileRevisions = 'platform-file-revisions';
const maximumFileBytes = 20 * 1024 * 1024;

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
    const checkPath = createPathAccess({ workspace: workspace.root, projectOnly: true, protectedDirectories });
    let checked;
    try { checked = await checkPath(name, { file: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) reject('file_not_found', 'Workspace file is unavailable', 404);
      throw error;
    }
    const handle = await open(checked, 'r');
    try {
      const size = await handle.stat();
      if (!size.isFile() || size.size > maximumFileBytes) reject('file_too_large', 'File exceeds the storage size limit', 413);
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
      return { bytes, root: workspace.root, source, path: name };
    } finally { await handle.close(); }
  }

  list(context, scope) {
    return this.store.list(files).filter(file => (!scope || sameRef(file.space, scope)) && this.canRead(file.id, context)).map(file => this.view(file));
  }

  canRead(id, context) {
    const file = this.get(id);
    if (context.session && !context.resource_refs?.some(ref => sameRef(ref, { kind: 'file', id })) &&
        !sameRef(file?.created_in, { kind: 'session', id: context.session.id })) return false;
    if (file) return this.canReadSpace(context.actor, file.space, { workspaceProfileId: context.workspaceProfileId });
    try {
      this.room.attachment(id, context.actor.id, { workspaceProfileId: context.workspaceProfileId });
      return true;
    } catch (error) {
      if ([403, 404].includes(error.status)) return false;
      throw error;
    }
  }

  view(file) {
    const { id, space, path, revision, size, author, sources, createdAt, updatedAt } = file;
    return { kind: 'file', id, ref: { kind: 'file', id }, name: posix.basename(path), path, space, revision, size, author, sources,
      created_at: createdAt, updated_at: updatedAt, url: `/api/files/${encodeURIComponent(id)}/download` };
  }

  getProjection(id, context) {
    if (!this.canRead(id, context)) reject('file_not_found', 'File is unavailable', 404);
    const file = this.get(id);
    if (file) return { file, projection: this.view(file) };
    const attachment = this.attachments.project(this.room.attachment(id, context.actor.id, { workspaceProfileId: context.workspaceProfileId }));
    return { file, projection: { ...attachment, kind: 'file', id, ref: { kind: 'file', id }, revision: 1 } };
  }

  read(id, context, cursor, limit) {
    const { file, projection } = this.getProjection(id, context);
    return this.pageText(projection, file?.content, cursor, limit);
  }

  async readObject(id, context, cursor, limit) {
    const { file, projection } = this.getProjection(id, context);
    if (file && !file.attachment_id && file.blob == null) return this.pageText(projection, file.content, cursor, limit);
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
    if (!Number.isSafeInteger(size) || size > maximumFileBytes) reject('file_too_large', 'File exceeds the storage size limit', 413);
    const id = before?.id || callId;
    const revision = (before?.revision || 0) + 1;
    const saved = this.store.save(files, { id, space, path, revision, size, author: context.actor, sources, content, attachment_id, blob,
      created_in: before?.created_in ?? (context.session ? { kind: 'session', id: context.session.id } : null), call_id: callId });
    this.store.save(fileRevisions, { ...saved, id: keyOf(id, revision), file_id: id });
    this.notify({ id: keyOf('file', id, revision), kind: 'event', type: 'file.revised', space, ref: { kind: 'file', id }, author: context.actor,
      previous_revision: before?.revision ?? null, revision, call_id: callId, time: new Date().toISOString() });
    return this.view(saved);
  }

  async download(id, context) {
    if (!this.canRead(id, context)) reject('file_not_found', 'File is unavailable', 404);
    const file = this.get(id);
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
