import { z } from 'zod';
import { LIMITS } from '@basecraft/shared';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { created, noContent, withHeaders, type AppContext, type Ctx } from '../http.js';
import { QuerySchema, runQuery, type QueryInput } from '../query.js';
import { createRecords, deleteRecord, loadAttachments, loadFields, parseIfMatch, toApi, updateRecord, type RecordRow, type WriteCtx } from '../records.js';
import { principalId, actorOf } from '../types.js';
import { ViewConfigSchema } from '../viewConfig.js';
import { idParam, uuid, type Reg } from './common.js';
import type { Client } from '../db.js';

const fieldsObj = z.record(z.string(), z.unknown());
const version = z.number().int().min(1);

export function writeCtxFor(ctx: Ctx, tableId: string, extra: Partial<WriteCtx> = {}): WriteCtx {
  return {
    c: ctx.c!, workspaceId: ctx.access!.workspaceId, baseId: ctx.access!.baseId!, tableId,
    actor: actorOf(ctx.principal), source: ctx.principal?.type === 'token' ? 'api' : 'ui', ip: ctx.req.ip, traceId: ctx.traceId, ...extra,
  };
}

/** Merge a saved view's search/filter/sort under the request's own parameters. Personal views of other users are invisible. */
export async function applyView(c: Client, ctx: Ctx, tableId: string, q: QueryInput): Promise<QueryInput> {
  if (!q.view_id) return q;
  const v = (await c.query(`SELECT visibility, owner_id, config, type FROM views WHERE id=$1 AND table_id=$2`, [q.view_id, tableId])).rows[0];
  const p = ctx.principal!;
  if (!v || (v.visibility === 'personal' && (p.type !== 'user' || v.owner_id !== p.userId))) throw notFound('View');
  const cfg = ViewConfigSchema.parse(v.config);
  const merged: QueryInput = { ...q };
  if (cfg.search && !q.search) merged.search = cfg.search;
  if (cfg.sort?.length && !q.sort) merged.sort = cfg.sort;
  if (cfg.filter) merged.filter = q.filter ? { and: [cfg.filter, q.filter] } : cfg.filter;
  return merged;
}

export function recordRoutes(reg: Reg, app: AppContext) {
  const secret = app.config.SERVER_SECRET;
  const tableP = idParam('tableId');
  const readScope = { resource: 'table', param: 'tableId', permission: 'records:read' } as const;
  const writeScope = { resource: 'table', param: 'tableId', permission: 'records:write' } as const;

  reg({
    method: 'GET', path: '/tables/:tableId/records', tag: 'Records', auth: 'any',
    summary: 'List records (cursor pagination, field projection). Use POST /records/query for filter groups and sorts.',
    params: tableP,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(), cursor: z.string().max(4000).optional(),
      fields: z.string().max(8000).optional(), search: z.string().max(200).optional(), view_id: uuid.optional(),
      include_total: z.enum(['true', 'false']).optional(),
    }).strict(),
    scope: readScope,
    async handler(ctx) {
      const f = await loadFields(ctx.c!, ctx.params.tableId);
      const q: QueryInput = { limit: ctx.query.limit, cursor: ctx.query.cursor, search: ctx.query.search, view_id: ctx.query.view_id, include_total: ctx.query.include_total === 'true',
        fields: ctx.query.fields?.split(',').map((s: string) => s.trim()).filter(Boolean) };
      return runQuery(ctx.c!, ctx.params.tableId, f, await applyView(ctx.c!, ctx, ctx.params.tableId, q), secret);
    },
  });

  reg({
    method: 'POST', path: '/tables/:tableId/records/query', tag: 'Records', auth: 'any',
    summary: 'Query records with filter groups (AND/OR), sorts, search, projection, and stable cursor pagination',
    params: tableP, body: QuerySchema, scope: readScope,
    async handler(ctx) {
      const f = await loadFields(ctx.c!, ctx.params.tableId);
      return runQuery(ctx.c!, ctx.params.tableId, f, await applyView(ctx.c!, ctx, ctx.params.tableId, ctx.body), secret);
    },
  });

  const createBody = z.union([
    z.object({ fields: fieldsObj }).strict(),
    z.object({ records: z.array(z.object({ fields: fieldsObj }).strict()).min(1).max(LIMITS.maxBatch) }).strict(),
  ]);
  reg({
    method: 'POST', path: '/tables/:tableId/records', tag: 'Records', auth: 'any', idempotent: true,
    summary: 'Create one record ({fields}) or up to 100 atomically ({records:[...]}). Supports Idempotency-Key.',
    params: tableP, body: createBody, scope: writeScope,
    async handler(ctx) {
      const f = await loadFields(ctx.c!, ctx.params.tableId);
      const w = writeCtxFor(ctx, ctx.params.tableId);
      if ('records' in ctx.body) {
        const out = await createRecords(w, f, ctx.body.records.map((r: any) => r.fields));
        return created({ records: out });
      }
      const [rec] = await createRecords(w, f, [ctx.body.fields]);
      return created(rec, { etag: `"${rec!.version}"`, location: `/api/v1/records/${rec!.id}` });
    },
  });

  reg({
    method: 'GET', path: '/records/:recordId', tag: 'Records', auth: 'any', summary: 'Get one record (ETag = version)',
    params: idParam('recordId'), query: z.object({ fields: z.string().max(8000).optional() }).strict(),
    scope: { resource: 'record', param: 'recordId', permission: 'records:read' },
    async handler(ctx) {
      const c = ctx.c!;
      const row = (await c.query(`SELECT id, seq, version, "values", created_at, updated_at, created_by, updated_by, table_id FROM records WHERE id=$1`, [ctx.params.recordId])).rows[0] as RecordRow & { table_id: string };
      if (!row) throw notFound('Record');
      const f = await loadFields(c, row.table_id);
      const att = await loadAttachments(c, [row.id], f);
      const proj = ctx.query.fields ? new Set<string>(ctx.query.fields.split(',')) : undefined;
      const rec = toApi(row, f, att, proj);
      return withHeaders(rec, { etag: `"${rec.version}"` });
    },
  });

  const versionFrom = (ctx: Ctx, bodyVersion?: number): number => {
    const v = parseIfMatch(ctx.req.headers['if-match']) ?? bodyVersion ?? null;
    if (v === null) throw new HttpError(428, 'precondition_required', 'Send the record version in an If-Match header (or "version" in the body) so concurrent edits are not lost');
    return v;
  };

  reg({
    method: 'PATCH', path: '/records/:recordId', tag: 'Records', auth: 'any',
    summary: 'Update fields of a record (only the supplied fields change; null clears). Requires If-Match: "<version>" or body.version → 412 on conflict.',
    params: idParam('recordId'), body: z.object({ fields: fieldsObj, version: version.optional() }).strict(),
    scope: { resource: 'record', param: 'recordId', permission: 'records:write' },
    async handler(ctx) {
      const c = ctx.c!;
      const meta = (await c.query(`SELECT table_id FROM records WHERE id=$1`, [ctx.params.recordId])).rows[0];
      if (!meta) throw notFound('Record');
      const f = await loadFields(c, meta.table_id);
      const rec = await updateRecord(writeCtxFor(ctx, meta.table_id), f, ctx.params.recordId, versionFrom(ctx, ctx.body.version), ctx.body.fields);
      return withHeaders(rec, { etag: `"${rec.version}"` });
    },
  });

  reg({
    method: 'DELETE', path: '/records/:recordId', tag: 'Records', auth: 'any',
    summary: 'Delete a record. Requires If-Match: "<version>" (or ?version=).', params: idParam('recordId'), query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    scope: { resource: 'record', param: 'recordId', permission: 'records:delete' },
    async handler(ctx) {
      const c = ctx.c!;
      const meta = (await c.query(`SELECT table_id FROM records WHERE id=$1`, [ctx.params.recordId])).rows[0];
      if (!meta) throw notFound('Record');
      const f = await loadFields(c, meta.table_id);
      await deleteRecord(writeCtxFor(ctx, meta.table_id), f, ctx.params.recordId, versionFrom(ctx, ctx.query.version));
      return noContent();
    },
  });

  const op = z.discriminatedUnion('op', [
    z.object({ op: z.literal('create'), fields: fieldsObj }).strict(),
    z.object({ op: z.literal('update'), id: uuid, version, fields: fieldsObj }).strict(),
    z.object({ op: z.literal('delete'), id: uuid, version }).strict(),
  ]);
  reg({
    method: 'POST', path: '/tables/:tableId/records/batch', tag: 'Records', auth: 'any', idempotent: true,
    summary: 'Apply up to 100 create/update/delete operations atomically (all succeed or none do). Updates and deletes carry their expected version.',
    params: tableP, body: z.object({ operations: z.array(op).min(1).max(LIMITS.maxBatch) }).strict(), scope: writeScope,
    async handler(ctx) {
      const f = await loadFields(ctx.c!, ctx.params.tableId);
      const w = writeCtxFor(ctx, ctx.params.tableId);
      if (ctx.body.operations.some((o: any) => o.op === 'delete')) ctx.require('records:delete');
      const results: unknown[] = [];
      for (const [i, o] of ctx.body.operations.entries()) {
        try {
          if (o.op === 'create') results.push({ op: 'create', record: (await createRecords(w, f, [o.fields]))[0] });
          else if (o.op === 'update') results.push({ op: 'update', record: await updateRecord(w, f, o.id, o.version, o.fields) });
          else { await deleteRecord(w, f, o.id, o.version); results.push({ op: 'delete', id: o.id }); }
        } catch (e) {
          if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Operation ${i} failed: ${e.message}`, { operation_index: i, ...(typeof e.details === 'object' && e.details ? { cause: e.details } : {}) });
          throw e;
        }
      }
      return created({ results });
    },
  });

  // ───────── comments (commenter role can write these but not edit records) ─────────
  reg({
    method: 'GET', path: '/records/:recordId/comments', tag: 'Comments', auth: 'session', summary: 'List comments on a record',
    params: idParam('recordId'), scope: { resource: 'record', param: 'recordId', permission: 'comments:read' },
    async handler(ctx) {
      const r = await ctx.c!.query(
        `SELECT c.id, c.body, c.created_at, c.author_id, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.record_id=$1 ORDER BY c.created_at LIMIT 500`, [ctx.params.recordId]);
      return { comments: r.rows };
    },
  });
  reg({
    method: 'POST', path: '/records/:recordId/comments', tag: 'Comments', auth: 'session', summary: 'Add a comment (plain text)',
    params: idParam('recordId'), body: z.object({ body: z.string().trim().min(1).max(10000) }).strict(),
    scope: { resource: 'record', param: 'recordId', permission: 'comments:write' },
    async handler(ctx) {
      const r = await ctx.c!.query(`INSERT INTO comments (workspace_id, record_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id, body, created_at, author_id`,
        [ctx.access!.workspaceId, ctx.params.recordId, principalId(ctx.principal!), ctx.body.body]);
      await ctx.audit('comment.create', { type: 'record', id: ctx.params.recordId });
      return created(r.rows[0]);
    },
  });
  void unprocessable;
}
