import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { csvSafeCell, type SelectOption } from '@basecraft/shared';
import { audit } from '../audit.js';
import { withWorkspace } from '../db.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { isReadonlyType, toCsvCell } from '../fieldTypes.js';
import { accepted, type AppContext } from '../http.js';
import { checkMapping, convertRow, importDir, ImportOptionsSchema, MappingSchema, newParser, type RowError } from '../importer.js';
import { iterateQuery, QuerySchema, type QueryInput } from '../query.js';
import { loadFields } from '../records.js';
import { actorOf } from '../types.js';
import { createReadStream } from 'node:fs';
import { applyView } from './records.js';
import { idParam, type Reg } from './common.js';

const jobCols = `id, table_id, status, filename, rows_total, rows_processed, rows_created, rows_updated, rows_skipped, rows_failed, errors, checkpoint_row, last_error, created_at, finished_at, options`;

export function importExportRoutes(reg: Reg, app: AppContext) {
  const tableP = idParam('tableId');
  const importScope = { resource: 'table', param: 'tableId', permission: 'records:import', tx: false } as const;

  /** Reads the multipart request: saves the CSV to disk and returns the parsed JSON text fields. */
  async function receive(ctx: any, dest: string): Promise<{ fields: Record<string, string>; filename: string; bytes: number }> {
    const fields: Record<string, string> = {};
    let filename = '', bytes = 0, gotFile = false;
    for await (const part of ctx.req.parts({ limits: { fileSize: app.config.MAX_IMPORT_BYTES } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || gotFile) { part.file.resume(); continue; }
        gotFile = true; filename = (part.filename ?? 'import.csv').slice(0, 200);
        part.file.on('data', (d: Buffer) => { bytes += d.length; });
        await pipeline(part.file, createWriteStream(dest, { mode: 0o600 }));
        if (part.file.truncated) { await rm(dest, { force: true }); throw new HttpError(413, 'file_too_large', `CSV files can be at most ${app.config.MAX_IMPORT_BYTES} bytes`); }
      } else fields[part.fieldname] = String(part.value);
    }
    if (!gotFile) throw new HttpError(400, 'file_required', 'Send the CSV as multipart/form-data part "file"');
    return { fields, filename, bytes };
  }
  const json = <T>(schema: z.ZodType<T>, raw: string | undefined, name: string, fallback?: unknown): T => {
    let v: unknown = fallback;
    if (raw !== undefined) { try { v = JSON.parse(raw); } catch { throw unprocessable(`${name} must be valid JSON`); } }
    const r = schema.safeParse(v);
    if (!r.success) throw new HttpError(422, 'validation_failed', `Invalid ${name}`, r.error.issues.slice(0, 20).map((i) => ({ path: `${name}.${i.path.join('.')}`, message: i.message })));
    return r.data;
  };

  reg({
    method: 'POST', path: '/tables/:tableId/imports/preview', tag: 'Import/Export', auth: 'session', multipart: true,
    summary: 'Preview a CSV: headers, sample rows, row count, suggested column mapping, and validation of the first 500 rows (nothing is stored)',
    params: tableP, scope: importScope,
    async handler(ctx) {
      const ws = ctx.access!.workspaceId;
      const tmp = `${importDir(app, ws)}/preview-${randomUUID()}.csv`;
      try {
        const up = await receive(ctx, tmp);
        const fields = await withWorkspace(app.db, ws, (c) => loadFields(c, ctx.params.tableId));
        const hasHeader = up.fields.has_header !== 'false';
        const sample: string[][] = [];
        let header: string[] = [], count = 0, cols = 0;
        const mapping = up.fields.mapping ? json(MappingSchema, up.fields.mapping, 'mapping') : null;
        const byId = mapping ? checkMapping(fields, mapping, ImportOptionsSchema.parse({ has_header: hasHeader })) : null;
        const errors: RowError[] = [];
        let first = true;
        const parser = createReadStream(tmp).pipe(newParser());
        for await (const rec of parser as AsyncIterable<string[]>) {
          cols = Math.max(cols, rec.length);
          if (first && hasHeader) { header = rec; first = false; continue; }
          first = false;
          count++;
          if (sample.length < 10) sample.push(rec);
          if (byId && count <= 500) errors.push(...convertRow(byId, mapping!, rec, count).errors);
          if (count > app.config.MAX_IMPORT_ROWS) throw new HttpError(422, 'too_many_rows', `Imports are limited to ${app.config.MAX_IMPORT_ROWS} rows`);
        }
        const names = new Map(fields.filter((f) => !isReadonlyType(f.type)).map((f) => [f.name.trim().toLowerCase(), f.id]));
        const suggested = header.map((h, i) => ({ column: i, field: names.get(h.trim().toLowerCase()) ?? null }));
        return { filename: up.filename, bytes: up.bytes, columns: cols, header, sample, row_count: count, suggested_mapping: suggested, validated_rows: Math.min(count, 500), errors: errors.slice(0, 100) };
      } catch (e: any) {
        if (e?.code?.startsWith?.('CSV_')) throw new HttpError(422, 'csv_parse_error', `The file is not valid CSV: ${e.message}`);
        throw e;
      } finally { await rm(tmp, { force: true }); }
    },
  });

  reg({
    method: 'POST', path: '/tables/:tableId/imports', tag: 'Import/Export', auth: 'session', multipart: true,
    summary: 'Start a CSV import job. Multipart parts: file, mapping (JSON [{column, field}]), options (JSON). Validates the whole file first; rows commit in atomic batches of 500; resumable.',
    params: tableP, scope: importScope,
    async handler(ctx) {
      const ws = ctx.access!.workspaceId;
      const jobId = randomUUID();
      const path = `${importDir(app, ws)}/${jobId}.csv`;
      try {
        const up = await receive(ctx, path);
        const mapping = json(MappingSchema, up.fields.mapping, 'mapping');
        const options = json(ImportOptionsSchema, up.fields.options, 'options', {});
        const job = await withWorkspace(app.db, ws, async (c) => {
          checkMapping(await loadFields(c, ctx.params.tableId), mapping, options);
          const r = await c.query(
            `INSERT INTO import_jobs (id, workspace_id, table_id, created_by, filename, file_key, mapping, options) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${jobCols}`,
            [jobId, ws, ctx.params.tableId, (ctx.principal as any).userId, up.filename, path, JSON.stringify(mapping), JSON.stringify(options)]);
          await audit(c, { workspaceId: ws, actor: actorOf(ctx.principal), action: 'import.start', targetType: 'import_job', targetId: jobId, metadata: { table_id: ctx.params.tableId, filename: up.filename, bytes: up.bytes, options }, ip: ctx.req.ip, traceId: ctx.traceId });
          return r.rows[0];
        });
        return accepted(job);
      } catch (e) { await rm(path, { force: true }); throw e; }
    },
  });

  reg({
    method: 'GET', path: '/tables/:tableId/imports', tag: 'Import/Export', auth: 'session', summary: 'Recent import jobs for a table',
    params: tableP, scope: { resource: 'table', param: 'tableId', permission: 'records:import' },
    async handler(ctx) {
      return { jobs: (await ctx.c!.query(`SELECT ${jobCols} FROM import_jobs WHERE table_id=$1 ORDER BY created_at DESC LIMIT 20`, [ctx.params.tableId])).rows };
    },
  });

  reg({
    method: 'GET', path: '/imports/:jobId', tag: 'Import/Export', auth: 'session', summary: 'Import job status, counters, and the validation report',
    params: idParam('jobId'), scope: { resource: 'import_job', param: 'jobId', permission: 'records:import' },
    async handler(ctx) { return (await ctx.c!.query(`SELECT ${jobCols} FROM import_jobs WHERE id=$1`, [ctx.params.jobId])).rows[0]; },
  });

  reg({
    method: 'POST', path: '/imports/:jobId/cancel', tag: 'Import/Export', auth: 'session', summary: 'Cancel a queued/running import (already-committed batches stay)',
    params: idParam('jobId'), scope: { resource: 'import_job', param: 'jobId', permission: 'records:import' },
    async handler(ctx) {
      const r = await ctx.c!.query(`UPDATE import_jobs SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING ${jobCols}`, [ctx.params.jobId]);
      if (!r.rows[0]) throw new HttpError(409, 'not_cancellable', 'Only queued or running imports can be cancelled');
      await ctx.audit('import.cancel', { type: 'import_job', id: ctx.params.jobId });
      return r.rows[0];
    },
  });

  reg({
    method: 'POST', path: '/imports/:jobId/resume', tag: 'Import/Export', auth: 'session', summary: 'Resume a failed import from its last committed batch (the uploaded file is kept for failed jobs)',
    params: idParam('jobId'), scope: { resource: 'import_job', param: 'jobId', permission: 'records:import' },
    async handler(ctx) {
      const j = (await ctx.c!.query(`SELECT file_key, status FROM import_jobs WHERE id=$1 FOR UPDATE`, [ctx.params.jobId])).rows[0];
      if (j.status !== 'failed') throw new HttpError(409, 'not_resumable', 'Only failed imports can be resumed');
      const { existsSync } = await import('node:fs');
      if (!existsSync(j.file_key)) throw new HttpError(409, 'file_gone', 'The uploaded file is no longer available; start a new import');
      const r = await ctx.c!.query(`UPDATE import_jobs SET status='queued', last_error=NULL, finished_at=NULL, locked_until=NULL WHERE id=$1 RETURNING ${jobCols}`, [ctx.params.jobId]);
      return accepted(r.rows[0]);
    },
  });

  // ───────── export: streams the full authorized selection, never just the loaded page ─────────
  const exportBody = z.object({
    format: z.enum(['csv', 'json']).default('csv'),
    query: QuerySchema.pick({ search: true, filter: true, sort: true, view_id: true }).optional(),
    fields: z.array(z.string().uuid()).max(200).optional(),
  }).strict();

  reg({
    method: 'POST', path: '/tables/:tableId/export', tag: 'Import/Export', auth: 'any',
    summary: 'Export ALL records matching the optional query/view (CSV or JSON), streamed in bounded batches. Formula-injection-safe CSV.',
    params: tableP, body: exportBody, scope: { resource: 'table', param: 'tableId', permission: 'records:export', tx: false },
    async handler(ctx) {
      const ws = ctx.access!.workspaceId, tableId = ctx.params.tableId;
      const { fields: all, q } = await withWorkspace(app.db, ws, async (c) => {
        const fields = await loadFields(c, tableId);
        const base: QueryInput = { ...(ctx.body.query ?? {}) };
        return { fields, q: await applyView(c, ctx as any, tableId, base) };
      });
      const cols = ctx.body.fields ? ctx.body.fields.map((id: string) => all.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f) : all;
      if (ctx.body.fields && cols.length !== ctx.body.fields.length) throw unprocessable('Unknown field in export selection');
      const stored = cols.map((f) => f.id).filter((id) => !['created_time', 'modified_time', 'attachment'].includes(all.find((f) => f.id === id)!.type));
      const projection = { ...q, fields: cols.map((f) => f.id) };
      void stored;
      const max = app.config.MAX_EXPORT_ROWS;
      const run = <T>(fn: (c: import('../db.js').Client) => Promise<T>) => withWorkspace(app.db, ws, fn);
      let rowsOut = 0;
      const fmt = ctx.body.format;
      async function* gen() {
        try {
          if (fmt === 'csv') {
            yield '﻿' + cols.map((f) => csvCell(csvSafeCell(f.name))).join(',') + '\r\n';
            for await (const rec of iterateQuery(run, tableId, all, projection, app.config.SERVER_SECRET, 1000, max)) {
              rowsOut++;
              yield cols.map((f) => {
                const text = toCsvCell(f, rec.fields[f.id]);
                // numbers are validated decimals, so only free text can carry a spreadsheet formula
                return csvCell(['integer', 'decimal', 'currency', 'percent', 'created_time', 'modified_time', 'date', 'datetime', 'checkbox'].includes(f.type) ? text : csvSafeCell(text));
              }).join(',') + '\r\n';
            }
          } else {
            yield `{"table_id":${JSON.stringify(tableId)},"fields":${JSON.stringify(cols.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options })))},"records":[`;
            let first = true;
            for await (const rec of iterateQuery(run, tableId, all, projection, app.config.SERVER_SECRET, 1000, max)) {
              rowsOut++;
              yield (first ? '' : ',') + JSON.stringify({ id: rec.id, version: rec.version, fields: rec.fields });
              first = false;
            }
            yield ']}';
          }
        } finally {
          await withWorkspace(app.db, ws, (c) => audit(c, { workspaceId: ws, actor: actorOf(ctx.principal), action: 'records.export', targetType: 'table', targetId: tableId, metadata: { format: fmt, rows: rowsOut, scope: 'all-matching', query: ctx.body.query ?? null }, ip: ctx.req.ip, traceId: ctx.traceId })).catch(() => {});
        }
      }
      const name = `export-${new Date().toISOString().slice(0, 10)}.${fmt}`;
      ctx.reply.header('content-type', fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
      return ctx.reply.send(Readable.from(gen(), { objectMode: false }));
    },
  });
  void notFound; void ({} as SelectOption);
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
