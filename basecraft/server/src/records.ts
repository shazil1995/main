import { LIMITS } from '@basecraft/shared';
import { auditMany } from './audit.js';
import type { Client } from './db.js';
import { unprocessable, versionConflict, notFound, ValueError } from './errors.js';
import { isReadonlyType, normalizeValue, searchTextOf, type FieldRow } from './fieldTypes.js';
import type { Actor } from './types.js';

export type EventSource = 'ui' | 'api' | 'import' | 'automation' | 'form' | 'system';

export interface WriteCtx {
  c: Client;
  workspaceId: string;
  baseId: string;
  tableId: string;
  actor: Actor;
  source: EventSource;
  /** Propagated through automation actions so recursive chains are detected and capped. */
  chainId?: string;
  depth?: number;
  visited?: string[];
  ip?: string;
  traceId?: string;
  /** 'each' = one audit row per record; 'summary' = one row per call (bulk imports). */
  auditMode?: 'each' | 'summary';
  /** Marks the event as a form submission so form_submitted automations fire. */
  formSubmission?: boolean;
}

export interface RecordRow {
  id: string; seq: number; version: number; values: Record<string, unknown>;
  created_at: Date; updated_at: Date; created_by: string | null; updated_by: string | null;
}
export interface ApiRecord {
  id: string; version: number; fields: Record<string, unknown>;
  created_time: string; modified_time: string; created_by: string | null; updated_by: string | null;
}

export async function loadFields(c: Client, tableId: string): Promise<FieldRow[]> {
  const r = await c.query(
    `SELECT id, name, type, options, position, is_primary, indexed FROM fields WHERE table_id = $1 AND deleted_at IS NULL ORDER BY position, created_at`, [tableId]);
  return r.rows as FieldRow[];
}

/** Validate a write payload. Collects ALL problems so the UI can show them together. */
export function prepareWrite(fields: FieldRow[], input: Record<string, unknown>): { set: Record<string, unknown>; clear: string[] } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const errors: { field: string; message: string }[] = [];
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const keys = Object.keys(input);
  if (keys.length > LIMITS.maxFieldsPerTable) throw unprocessable('Too many fields in one record');
  for (const k of keys) {
    const f = byId.get(k);
    if (!f) { errors.push({ field: k, message: 'Unknown field id' }); continue; }
    if (isReadonlyType(f.type)) { errors.push({ field: k, message: `${f.name} is read-only` }); continue; }
    try {
      const v = normalizeValue(f, input[k]);
      if (v === null) clear.push(k); else set[k] = v;
    } catch (e) {
      if (e instanceof ValueError) errors.push({ field: k, message: e.message });
      else throw e;
    }
  }
  if (errors.length) throw unprocessable('Some values are invalid', errors);
  return { set, clear };
}

function sizeCheck(values: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(values)) > LIMITS.maxRecordBytes) throw unprocessable(`Record is larger than ${LIMITS.maxRecordBytes} bytes`);
}

export function toApi(row: RecordRow, fields: FieldRow[], attachments?: Map<string, any[]>, project?: Set<string>): ApiRecord {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (project && !project.has(f.id)) continue;
    if (f.type === 'created_time') out[f.id] = row.created_at.toISOString();
    else if (f.type === 'modified_time') out[f.id] = row.updated_at.toISOString();
    else if (f.type === 'attachment') out[f.id] = attachments?.get(`${row.id}:${f.id}`) ?? [];
    else if (row.values[f.id] !== undefined && row.values[f.id] !== null) out[f.id] = row.values[f.id];
  }
  return { id: row.id, version: row.version, fields: out, created_time: row.created_at.toISOString(), modified_time: row.updated_at.toISOString(), created_by: row.created_by, updated_by: row.updated_by };
}

export async function loadAttachments(c: Client, recordIds: string[], fields: FieldRow[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  const attFields = fields.filter((f) => f.type === 'attachment').map((f) => f.id);
  if (!recordIds.length || !attFields.length) return out;
  const r = await c.query(
    `SELECT id, record_id, field_id, filename, content_type, size_bytes, created_at FROM attachments
      WHERE record_id = ANY($1::uuid[]) AND field_id = ANY($2::uuid[]) AND deleted_at IS NULL AND status = 'clean' ORDER BY created_at`,
    [recordIds, attFields]);
  for (const a of r.rows) {
    const k = `${a.record_id}:${a.field_id}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push({ id: a.id, filename: a.filename, content_type: a.content_type, size: Number(a.size_bytes), created_time: a.created_at.toISOString() });
  }
  return out;
}

async function hasSubscribers(c: Client, tableId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM automations WHERE table_id = $1 AND enabled LIMIT 1`, [tableId])).rowCount! > 0;
}

interface Ev { type: 'record.created' | 'record.updated' | 'record.deleted' | 'form.submitted'; recordId: string; payload: unknown }
async function emit(w: WriteCtx, events: Ev[]) {
  if (!events.length || !(await hasSubscribers(w.c, w.tableId))) return;
  await w.c.query(
    `INSERT INTO outbox_events (workspace_id, table_id, record_id, type, source, chain_id, depth, visited_automations, payload)
     SELECT $1, $2, t.rid, t.typ, $3, $4, $5, $6::uuid[], t.pl::jsonb FROM unnest($7::uuid[], $8::text[], $9::text[]) AS t(rid, typ, pl)`,
    [w.workspaceId, w.tableId, w.source, w.chainId ?? crypto.randomUUID(), w.depth ?? 0, w.visited ?? [],
      events.map((e) => e.recordId), events.map((e) => e.type), events.map((e) => JSON.stringify(e.payload))],
  );
}

async function auditRecords(w: WriteCtx, action: string, items: { id: string; meta?: Record<string, unknown> }[]) {
  if (!items.length) return;
  if (w.auditMode === 'summary' || items.length > 500) {
    await auditMany(w.c, [{ workspaceId: w.workspaceId, actor: w.actor, action: `${action}.bulk`, targetType: 'table', targetId: w.tableId, metadata: { count: items.length, source: w.source, first_ids: items.slice(0, 5).map((i) => i.id) }, ip: w.ip, traceId: w.traceId }]);
    return;
  }
  await auditMany(w.c, items.map((i) => ({ workspaceId: w.workspaceId, actor: w.actor, action, targetType: 'record', targetId: i.id, metadata: { table_id: w.tableId, source: w.source, ...i.meta }, ip: w.ip, traceId: w.traceId })));
}

export async function createRecords(w: WriteCtx, fields: FieldRow[], inputs: Record<string, unknown>[]): Promise<ApiRecord[]> {
  if (!inputs.length) return [];
  const valuesList: string[] = [], searchList: string[] = [];
  const prepared: Record<string, unknown>[] = [];
  inputs.forEach((input, idx) => {
    try {
      const { set } = prepareWrite(fields, input);
      sizeCheck(set);
      prepared.push(set);
      valuesList.push(JSON.stringify(set));
      searchList.push(searchTextOf(fields, set));
    } catch (e: any) {
      if (inputs.length > 1 && e?.details) e.details = { index: idx, errors: e.details };
      throw e;
    }
  });
  const r = await w.c.query(
    `INSERT INTO records (workspace_id, base_id, table_id, "values", search_text, created_by, updated_by)
     SELECT $1, $2, $3, t.v::jsonb, t.s, $4, $4 FROM unnest($5::text[], $6::text[]) AS t(v, s)
     RETURNING id, seq, version, "values", created_at, updated_at, created_by, updated_by`,
    [w.workspaceId, w.baseId, w.tableId, w.actor.type === 'system' ? null : creatorUserId(w.actor), valuesList, searchList]);
  const rows = (r.rows as RecordRow[]).sort((a, b) => a.seq - b.seq);
  await emit(w, rows.map((row) => ({
    type: w.formSubmission ? 'form.submitted' : 'record.created', recordId: row.id, payload: { after: row.values },
  })));
  await auditRecords(w, 'record.create', rows.map((row) => ({ id: row.id })));
  return rows.map((row) => toApi(row, fields));
}

/** Audit rows reference the acting user via actor.id; tokens act on behalf of nobody in `created_by`. */
function creatorUserId(actor: Actor): string | null {
  return actor.type === 'user' ? actor.id : null;
}

export async function getRecordForUpdate(c: Client, tableId: string, id: string): Promise<RecordRow> {
  const r = await c.query(`SELECT id, seq, version, "values", created_at, updated_at, created_by, updated_by FROM records WHERE id = $1 AND table_id = $2 FOR UPDATE`, [id, tableId]);
  if (!r.rows[0]) throw notFound('Record');
  return r.rows[0];
}

export async function updateRecord(w: WriteCtx, fields: FieldRow[], id: string, expectedVersion: number, patch: Record<string, unknown>): Promise<ApiRecord> {
  const cur = await getRecordForUpdate(w.c, w.tableId, id);
  if (cur.version !== expectedVersion) throw versionConflict(toApi(cur, fields));
  const { set, clear } = prepareWrite(fields, patch);
  const next: Record<string, unknown> = { ...cur.values };
  for (const k of clear) delete next[k];
  Object.assign(next, set);
  const changed = [...new Set([...Object.keys(set), ...clear])].filter((k) => JSON.stringify(cur.values[k] ?? null) !== JSON.stringify(next[k] ?? null));
  if (!changed.length) return toApi(cur, fields); // no-op: no version bump, no event
  sizeCheck(next);
  const r = await w.c.query(
    `UPDATE records SET "values" = $2::jsonb, search_text = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE id = $1 RETURNING id, seq, version, "values", created_at, updated_at, created_by, updated_by`,
    [id, JSON.stringify(next), searchTextOf(fields, next), creatorUserId(w.actor)]);
  const row = r.rows[0] as RecordRow;
  await emit(w, [{ type: 'record.updated', recordId: id, payload: { before: cur.values, after: next, changed } }]);
  await auditRecords(w, 'record.update', [{ id, meta: { changed_fields: changed, version: row.version } }]);
  return toApi(row, fields);
}

export async function deleteRecord(w: WriteCtx, fields: FieldRow[], id: string, expectedVersion: number): Promise<void> {
  const cur = await getRecordForUpdate(w.c, w.tableId, id);
  if (cur.version !== expectedVersion) throw versionConflict(toApi(cur, fields));
  await w.c.query(`UPDATE attachments SET deleted_at = now() WHERE record_id = $1 AND deleted_at IS NULL`, [id]);
  await w.c.query(`DELETE FROM records WHERE id = $1`, [id]);
  await emit(w, [{ type: 'record.deleted', recordId: id, payload: { before: cur.values } }]);
  await auditRecords(w, 'record.delete', [{ id }]);
}

export const parseIfMatch = (h: string | string[] | undefined): number | null => {
  const s = Array.isArray(h) ? h[0] : h;
  if (!s) return null;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(s.trim());
  return m ? Number(m[1]) : null;
};
