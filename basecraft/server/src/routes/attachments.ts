import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, forbidden, notFound, unprocessable } from '../errors.js';
import { withWorkspace } from '../db.js';
import { created, noContent, type AppContext } from '../http.js';
import { actorOf } from '../types.js';
import { LocalStore, SizeLimitError, checkUpload, contentDisposition, noopScanner, type BlobStore, type Scanner } from '../storage.js';
import { audit } from '../audit.js';
import { idParam, uuid, type Reg } from './common.js';

export interface Storage { store: BlobStore; scanner: Scanner }
export function getStorage(app: AppContext): Storage {
  app.storage ??= { store: new LocalStore(app.config.ATTACHMENT_DIR), scanner: noopScanner };
  return app.storage;
}

export function attachmentRoutes(reg: Reg, app: AppContext) {
  const maxFiles = 20;

  reg({
    method: 'POST', path: '/records/:recordId/attachments', tag: 'Attachments', auth: 'any', multipart: true,
    summary: 'Upload one file (multipart/form-data, part name "file") into an attachment field of a record. Query: field_id.',
    params: idParam('recordId'), query: z.object({ field_id: uuid }).strict(),
    scope: { resource: 'record', param: 'recordId', permission: 'attachments:write', tx: false },
    async handler(ctx) {
      const { recordId } = ctx.params, fieldId = ctx.query.field_id;
      const ws = ctx.access!.workspaceId;
      const st = getStorage(app);
      // 1) cheap checks in a short transaction so a slow upload never holds a DB connection
      const tableId = await withWorkspace(app.db, ws, async (c) => {
        const r = (await c.query(`SELECT r.table_id FROM records r WHERE r.id=$1`, [recordId])).rows[0];
        if (!r) throw notFound('Record');
        const f = (await c.query(`SELECT type FROM fields WHERE id=$1 AND table_id=$2 AND deleted_at IS NULL`, [fieldId, r.table_id])).rows[0];
        if (!f || f.type !== 'attachment') throw unprocessable('field_id must be an attachment field of this record\'s table');
        const n = (await c.query(`SELECT count(*)::int n FROM attachments WHERE record_id=$1 AND field_id=$2 AND deleted_at IS NULL`, [recordId, fieldId])).rows[0].n;
        if (n >= maxFiles) throw unprocessable(`At most ${maxFiles} files per cell`);
        return r.table_id as string;
      });
      // 2) stream the file to storage with a hard size cap
      const part = await ctx.req.file({ limits: { fileSize: app.config.MAX_ATTACHMENT_BYTES, files: 1 } });
      if (!part) throw new HttpError(400, 'file_required', 'Send the file as multipart/form-data part "file"');
      const key = `${ws}/${randomUUID()}`;
      let put;
      try {
        put = await st.store.put(key, part.file, app.config.MAX_ATTACHMENT_BYTES);
        if (part.file.truncated) throw new SizeLimitError('too large');
      } catch (e) {
        await st.store.delete(key).catch(() => {});
        if (e instanceof SizeLimitError) throw new HttpError(413, 'file_too_large', `Files can be at most ${app.config.MAX_ATTACHMENT_BYTES} bytes`);
        throw e;
      }
      const verdict = checkUpload(part.filename, put.head);
      if (!verdict.ok) { await st.store.delete(key).catch(() => {}); throw new HttpError(415, 'file_type_rejected', verdict.reason); }
      if (put.size === 0) { await st.store.delete(key).catch(() => {}); throw unprocessable('Empty files are not allowed'); }
      const scan = await st.scanner.scan(key, st.store);
      if (scan !== 'clean') { await st.store.delete(key).catch(() => {}); throw new HttpError(422, 'file_quarantined', 'The file failed malware scanning'); }
      // 3) record it, enforcing the workspace quota under a per-workspace advisory lock
      try {
        const row = await withWorkspace(app.db, ws, async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [ws]);
          const q = (await c.query(`SELECT w.attachment_quota_bytes q, coalesce((SELECT sum(size_bytes) FROM attachments WHERE deleted_at IS NULL),0) used FROM workspaces w WHERE w.id=$1`, [ws])).rows[0];
          if (Number(q.used) + put.size > Number(q.q)) throw new HttpError(413, 'quota_exceeded', 'This workspace has used its attachment storage quota');
          const gone = (await c.query(`SELECT 1 FROM records WHERE id=$1 FOR SHARE`, [recordId])).rowCount;
          if (!gone) throw notFound('Record');
          const r = await c.query(
            `INSERT INTO attachments (workspace_id, table_id, record_id, field_id, filename, content_type, size_bytes, sha256, storage_key, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'clean',$10) RETURNING id, filename, content_type, size_bytes, created_at`,
            [ws, tableId, recordId, fieldId, verdict.filename, verdict.contentType, put.size, put.sha256, key, ctx.principal!.type === 'user' ? ctx.principal!.userId : null]);
          await audit(c, { workspaceId: ws, actor: actorOf(ctx.principal), action: 'attachment.upload', targetType: 'attachment', targetId: r.rows[0].id, metadata: { record_id: recordId, size: put.size, content_type: verdict.contentType }, ip: ctx.req.ip, traceId: ctx.traceId });
          return r.rows[0];
        });
        return created({ id: row.id, filename: row.filename, content_type: row.content_type, size: Number(row.size_bytes), created_time: row.created_at });
      } catch (e) { await st.store.delete(key).catch(() => {}); throw e; }
    },
  });

  reg({
    method: 'GET', path: '/attachments/:attachmentId/download', tag: 'Attachments', auth: 'any',
    summary: 'Download a file (always as an attachment, never rendered inline)',
    params: idParam('attachmentId'), scope: { resource: 'attachment', param: 'attachmentId', permission: 'attachments:read', tx: false },
    async handler(ctx) {
      const a = await withWorkspace(app.db, ctx.access!.workspaceId, async (c) =>
        (await c.query(`SELECT filename, content_type, size_bytes, storage_key FROM attachments WHERE id=$1 AND deleted_at IS NULL AND status='clean'`, [ctx.params.attachmentId])).rows[0]);
      if (!a) throw notFound('Attachment');
      const stream = getStorage(app).store.get(a.storage_key);
      stream.on('error', (err) => ctx.req.log.error({ err }, 'attachment read failed'));
      ctx.reply.header('content-type', 'application/octet-stream')
        .header('content-disposition', contentDisposition(a.filename))
        .header('x-content-type-options', 'nosniff')
        .header('x-original-content-type', a.content_type)
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('content-length', String(a.size_bytes))
        .header('cache-control', 'private, no-store');
      return ctx.reply.send(stream);
    },
  });

  reg({
    method: 'DELETE', path: '/attachments/:attachmentId', tag: 'Attachments', auth: 'any', summary: 'Remove a file (blob is deleted by the orphan cleaner after a grace period)',
    params: idParam('attachmentId'), scope: { resource: 'attachment', param: 'attachmentId', permission: 'attachments:write' },
    async handler(ctx) {
      await ctx.c!.query(`UPDATE attachments SET deleted_at = now() WHERE id=$1`, [ctx.params.attachmentId]);
      await ctx.audit('attachment.delete', { type: 'attachment', id: ctx.params.attachmentId });
      return noContent();
    },
  });
  void forbidden;
}

/** Deletes blobs (and rows) for removed/orphaned attachments after `graceSeconds`. Safe to run repeatedly. */
export async function cleanupOrphanAttachments(app: AppContext, graceSeconds = 3600, limit = 200): Promise<number> {
  const st = getStorage(app);
  const rows = (await app.db.app.query(`SELECT * FROM bc_orphan_attachments($1, $2)`, [graceSeconds, limit])).rows;
  for (const r of rows) {
    await st.store.delete(r.storage_key);
    await app.db.app.query(`SELECT bc_purge_attachment_row($1)`, [r.id]);
  }
  return rows.length;
}
