import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { parse } from 'csv-parse';
import { z } from 'zod';
import type { AppContext } from './http.js';
import { withWorkspace } from './db.js';
import { HttpError } from './errors.js';
import { fromCsvCell, isReadonlyType, normalizeValue, searchTextOf, type FieldRow } from './fieldTypes.js';
import { ValueError } from './errors.js';
import { createRecords, loadFields, prepareWrite, updateRecord, type WriteCtx } from './records.js';

export const MappingSchema = z.array(z.object({ column: z.number().int().min(0).max(1000), field: z.string().uuid() }).strict()).min(1).max(200);
export const ImportOptionsSchema = z.object({
  has_header: z.boolean().default(true),
  duplicate_policy: z.enum(['create', 'skip', 'update']).default('create'),
  match_field: z.string().uuid().optional(),
  on_error: z.enum(['abort', 'skip_rows']).default('abort'),
  validate_only: z.boolean().default(false),
}).strict();
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;
export type Mapping = z.infer<typeof MappingSchema>;

const MAX_ERRORS = 200;

export interface RowError { row: number; column?: number; field?: string; message: string }

export function newParser() {
  return parse({ bom: true, relax_column_count: true, skip_empty_lines: true, max_record_size: 1_048_576, trim: false });
}

/** Convert one CSV row into validated field values, collecting every problem with its column. */
export function convertRow(byId: Map<string, FieldRow>, mapping: Mapping, cells: string[], rowNo: number): { values?: Record<string, unknown>; errors: RowError[] } {
  const input: Record<string, unknown> = {};
  const errors: RowError[] = [];
  const colOf = (fieldId: string) => mapping.find((m) => m.field === fieldId)?.column;
  for (const m of mapping) {
    const f = byId.get(m.field)!;
    const cell = cells[m.column];
    if (cell === undefined) continue;
    try { input[f.id] = fromCsvCell(f, cell); }
    catch (e) { if (e instanceof ValueError) errors.push({ row: rowNo, column: m.column, field: f.id, message: e.message }); else throw e; }
  }
  // validate everything that converted, so one row reports ALL its problems at once
  try {
    const { set } = prepareWrite([...byId.values()], input);
    return errors.length ? { errors } : { values: set, errors: [] };
  } catch (e) {
    if (e instanceof HttpError && Array.isArray(e.details)) {
      for (const d of e.details as { field: string; message: string }[]) errors.push({ row: rowNo, column: colOf(d.field), field: d.field, message: d.message });
      return { errors };
    }
    throw e;
  }
}

export function checkMapping(fields: FieldRow[], mapping: Mapping, options: ImportOptions) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (const m of mapping) {
    const f = byId.get(m.field);
    if (!f) throw new HttpError(422, 'validation_failed', 'Mapping references an unknown field', [{ field: m.field, message: 'Unknown field' }]);
    if (isReadonlyType(f.type)) throw new HttpError(422, 'validation_failed', `${f.name} is read-only and cannot be imported`, [{ field: m.field, message: 'Read-only field' }]);
    if (seen.has(m.field)) throw new HttpError(422, 'validation_failed', `${f.name} is mapped twice`);
    seen.add(m.field);
  }
  if (options.duplicate_policy !== 'create') {
    if (!options.match_field) throw new HttpError(422, 'validation_failed', 'match_field is required when duplicate_policy is skip or update');
    if (!seen.has(options.match_field)) throw new HttpError(422, 'validation_failed', 'match_field must be one of the mapped fields');
  }
  return byId;
}

interface JobRow {
  id: string; workspace_id: string; table_id: string; created_by: string | null; file_key: string;
  mapping: Mapping; options: ImportOptions; checkpoint_row: number;
}

async function* rows(path: string, skipHeader: boolean): AsyncGenerator<{ no: number; cells: string[] }> {
  const parser = createReadStream(path).pipe(newParser());
  let no = 0, first = true;
  try {
    for await (const rec of parser) {
      if (first && skipHeader) { first = false; continue; }
      first = false;
      yield { no: ++no, cells: rec as string[] };
    }
  } finally { parser.destroy(); }
}

const isCancelled = async (app: AppContext, job: JobRow) =>
  withWorkspace(app.db, job.workspace_id, async (c) => (await c.query(`SELECT status FROM import_jobs WHERE id=$1`, [job.id])).rows[0]?.status === 'cancelled');

/** Runs (or resumes) a claimed import job. Each batch commits atomically together with its progress counters. */
export async function runImportJob(app: AppContext, job: JobRow, heartbeat: () => Promise<void>): Promise<void> {
  const ws = job.workspace_id;
  const opts = job.options, mapping = job.mapping;
  const BATCH = Math.max(1, app.config.IMPORT_BATCH_ROWS);
  try {
    const { fields, baseId } = await withWorkspace(app.db, ws, async (c) => ({
      fields: await loadFields(c, job.table_id),
      baseId: (await c.query(`SELECT base_id FROM tables WHERE id=$1`, [job.table_id])).rows[0].base_id as string,
    }));
    const byId = checkMapping(fields, mapping, opts);

    // pass 1: validate the whole file without writing anything
    let total = 0, bad = 0;
    const errors: RowError[] = [];
    const badRows = new Set<number>();
    const maxRows = app.config.MAX_IMPORT_ROWS;
    for await (const r of rows(job.file_key, opts.has_header)) {
      if (++total > maxRows) throw new HttpError(422, 'too_many_rows', `Imports are limited to ${maxRows} rows`);
      const res = convertRow(byId, mapping, r.cells, r.no);
      if (res.errors.length) { bad++; badRows.add(r.no); for (const e of res.errors) if (errors.length < MAX_ERRORS) errors.push(e); }
      if (total % 5000 === 0) await heartbeat();
    }
    await withWorkspace(app.db, ws, (c) => c.query(`UPDATE import_jobs SET rows_total=$2, errors=$3 WHERE id=$1`, [job.id, total, JSON.stringify(errors)]));

    if (opts.validate_only) return finish(app, job, 'done', bad ? `${bad} row(s) have problems; nothing was written (validate only)` : null, { failed: bad });
    if (bad && opts.on_error === 'abort') return finish(app, job, 'failed', `${bad} row(s) are invalid. Nothing was imported. Fix the file or choose "skip invalid rows".`, { failed: bad });

    // pass 2: write valid rows in atomic batches
    const w0 = (c: import('./db.js').Client): WriteCtx => ({ c, workspaceId: ws, baseId, tableId: job.table_id, actor: job.created_by ? { type: 'user', id: job.created_by } : { type: 'system', id: null }, source: 'import', auditMode: 'summary' });
    let batch: { no: number; values: Record<string, unknown> }[] = [];
    let lastNo = job.checkpoint_row;
    const flush = async (upTo: number) => {
      const counters = await withWorkspace(app.db, ws, async (c) => {
        const w = w0(c);
        const ctr = { created: 0, updated: 0, skipped: 0 };
        const toCreate: Record<string, unknown>[] = [];
        let existing = new Map<string, { id: string; version: number }>();
        const seenInBatch = new Map<string, number>();
        if (opts.duplicate_policy !== 'create') {
          const keys = [...new Set(batch.map((b) => b.values[opts.match_field!]).filter((v) => v !== undefined).map(String))];
          if (keys.length) {
            const r = await c.query(`SELECT DISTINCT ON (k) id, version, k FROM (SELECT id, version, seq, "values"->>$2 AS k FROM records WHERE table_id=$1 AND "values"->>$2 = ANY($3::text[])) x ORDER BY k, seq`, [job.table_id, opts.match_field, keys]);
            existing = new Map(r.rows.map((x) => [x.k as string, { id: x.id as string, version: x.version as number }]));
          }
        }
        const deferredUpdates: { id: string; version: number; values: Record<string, unknown> }[] = [];
        for (const b of batch) {
          const key = opts.duplicate_policy !== 'create' && b.values[opts.match_field!] !== undefined ? String(b.values[opts.match_field!]) : undefined;
          if (key !== undefined && existing.has(key)) {
            if (opts.duplicate_policy === 'skip') { ctr.skipped++; continue; }
            const ex = existing.get(key)!;
            deferredUpdates.push({ id: ex.id, version: ex.version, values: b.values });
            ex.version++; // sequential updates to the same record within a batch
            continue;
          }
          if (key !== undefined) {
            if (seenInBatch.has(key)) {
              if (opts.duplicate_policy === 'skip') { ctr.skipped++; continue; }
              toCreate[seenInBatch.get(key)!] = { ...toCreate[seenInBatch.get(key)!], ...b.values }; ctr.skipped++; continue; // later duplicate row merges into the first
            }
            seenInBatch.set(key, toCreate.length);
          }
          toCreate.push(b.values);
        }
        if (toCreate.length) { await createRecords(w, fields, toCreate); ctr.created += toCreate.length; }
        for (const u of deferredUpdates) { await updateRecord(w, fields, u.id, u.version, u.values as Record<string, unknown>); ctr.updated++; }
        await c.query(
          `UPDATE import_jobs SET checkpoint_row=$2, rows_processed=rows_processed+$3, rows_created=rows_created+$4, rows_updated=rows_updated+$5, rows_skipped=rows_skipped+$6, locked_until=now()+interval '60 seconds' WHERE id=$1`,
          [job.id, upTo, batch.length + 0, ctr.created, ctr.updated, ctr.skipped]);
        return ctr;
      });
      void counters;
      batch = [];
      await app.hooks?.afterImportBatch?.(upTo);
    };

    let sinceFlush = 0;
    for await (const r of rows(job.file_key, opts.has_header)) {
      if (r.no <= job.checkpoint_row) continue; // already committed in an earlier run
      lastNo = r.no;
      if (badRows.has(r.no)) { sinceFlush++; if (sinceFlush >= BATCH) { await flush(lastNo); sinceFlush = 0; } continue; }
      const res = convertRow(byId, mapping, r.cells, r.no);
      batch.push({ no: r.no, values: res.values! });
      if (++sinceFlush >= BATCH) {
        await flush(lastNo); sinceFlush = 0;
        if (await isCancelled(app, job)) return finish(app, job, 'cancelled', null, {});
        await heartbeat();
      }
    }
    if (batch.length || sinceFlush) await flush(lastNo);
    await finish(app, job, 'done', null, { failed: bad });
  } catch (e: unknown) {
    const known = e instanceof HttpError;
    await finish(app, job, 'failed', known ? e.message : 'Import failed unexpectedly; it can be resumed.', {}, known);
    if (!known) throw e;
  }
}

async function finish(app: AppContext, job: JobRow, status: 'done' | 'failed' | 'cancelled', error: string | null, extra: { failed?: number }, dropFile = true) {
  await withWorkspace(app.db, job.workspace_id, async (c) => {
    await c.query(`UPDATE import_jobs SET status=$2::text, last_error=$3, rows_failed=coalesce($4::int, rows_failed), finished_at=now(), locked_until=NULL WHERE id=$1 AND (status <> 'cancelled' OR $2::text = 'cancelled')`, [job.id, status, error, extra.failed ?? null]);
    await c.query(`INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,'import.finish','import_job',$4,$5)`,
      [job.workspace_id, job.created_by ? 'user' : 'system', job.created_by, job.id, JSON.stringify({ status, table_id: job.table_id })]);
  });
  if (dropFile) await rm(job.file_key, { force: true });
}

export const importDir = (app: AppContext, ws: string) => { const d = `${app.config.IMPORT_DIR}/${ws}`; mkdirSync(d, { recursive: true }); return d; };
void normalizeValue; void searchTextOf;
