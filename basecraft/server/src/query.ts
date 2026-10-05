import { FIELD_SQL_KIND, LIMITS, OPERATORS_BY_KIND, OPERATORS_SINGLE_SELECT, FILTER_OPERATORS, type FilterOperator, type SelectOption, type SqlKind } from '@basecraft/shared';
import { z } from 'zod';
import { hmac, safeEqual } from './crypto.js';
import type { Client } from './db.js';
import { HttpError, ValueError, unprocessable } from './errors.js';
import { canonicalDecimal, isValidDate, normalizeDatetime, resolveOption, type FieldRow } from './fieldTypes.js';
import { loadAttachments, toApi, type ApiRecord, type RecordRow } from './records.js';

// ───────── request schema ─────────
export type FilterNode =
  | { field: string; op: FilterOperator; value?: unknown }
  | { and: FilterNode[] }
  | { or: FilterNode[] };

export const FilterSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().max(64), op: z.enum(FILTER_OPERATORS), value: z.unknown().optional() }).strict(),
    z.object({ and: z.array(FilterSchema).max(LIMITS.maxFilterConditions) }).strict(),
    z.object({ or: z.array(FilterSchema).max(LIMITS.maxFilterConditions) }).strict(),
  ]),
);

export const SortSchema = z.array(z.object({ field: z.string().max(64), direction: z.enum(['asc', 'desc']).default('asc') }).strict()).max(LIMITS.maxSorts);

export const QuerySchema = z.object({
  search: z.string().max(200).optional(),
  filter: FilterSchema.optional(),
  sort: SortSchema.optional(),
  fields: z.array(z.string().max(64)).max(LIMITS.maxFieldsPerTable).optional(),
  limit: z.number().int().min(1).max(LIMITS.maxPageSize).optional(),
  cursor: z.string().max(4000).optional(),
  view_id: z.string().uuid().optional(),
  include_total: z.boolean().optional(),
}).strict();
export type QueryInput = z.infer<typeof QuerySchema>;

// ───────── SQL building ─────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Params {
  values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

interface Col { sql: string; kind: SqlKind; field: FieldRow }

/**
 * Identifier safety: field ids are looked up in the table's real field list and must be UUIDs before they are ever
 * inlined as a JSON key literal. Clients can only pick ids; they never supply SQL text.
 */
function colOf(f: FieldRow): Col {
  if (!UUID_RE.test(f.id)) throw new Error('unsafe field id');
  const kind = FIELD_SQL_KIND[f.type];
  // bc_jtext is a (when provisioned) LEAKPROOF alias of jsonb ->> so equality/range on it can use expression indexes behind RLS
  const t = `bc_jtext(r."values", '${f.id}')`;
  switch (f.type) {
    case 'created_time': return { sql: 'r.created_at', kind, field: f };
    case 'modified_time': return { sql: 'r.updated_at', kind, field: f };
    case 'multi_select': return { sql: `(r."values"->'${f.id}')`, kind, field: f };
    case 'attachment': return { sql: 'NULL', kind, field: f };
    case 'checkbox': return { sql: `(${t}::boolean)`, kind, field: f };
    case 'integer': case 'decimal': case 'currency': case 'percent': return { sql: `(${t}::numeric)`, kind, field: f };
    default: return { sql: t, kind, field: f }; // text-like, date, datetime (fixed-width text sorts chronologically), single_select
  }
}
/** The raw stored text of a field (what leakproof, index-friendly equality compares against). */
const rawText = (f: FieldRow) => `bc_jtext(r."values", '${f.id}')`;
const numericScale = (f: FieldRow) => (f.type === 'integer' ? 0 : Number(f.options.scale ?? 2));

const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

function opsFor(f: FieldRow): FilterOperator[] {
  return f.type === 'single_select' ? OPERATORS_SINGLE_SELECT : OPERATORS_BY_KIND[FIELD_SQL_KIND[f.type]];
}

export function coerceScalar(f: FieldRow, v: unknown): string {
  switch (FIELD_SQL_KIND[f.type]) {
    case 'numeric': return canonicalDecimal(v, 8);
    case 'date': if (typeof v !== 'string' || !isValidDate(v)) throw new ValueError('Must be a date like 2026-03-08'); return v;
    case 'timestamptz':
      if (f.type === 'datetime') return normalizeDatetime(v, f.options.timezone);
      return normalizeDatetime(v, 'UTC');
    default:
      if (typeof v !== 'string') throw new ValueError('Must be text');
      if (v.length > LIMITS.maxShortTextLength) throw new ValueError('Too long');
      return v;
  }
}

export function optionIds(f: FieldRow, v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length || arr.length > 100) throw new ValueError('Provide 1-100 options');
  return arr.map((x) => {
    if (typeof x !== 'string') throw new ValueError('Options must be strings');
    const o = resolveOption(f.options.options as SelectOption[], x);
    if (!o) throw new ValueError(`"${x.slice(0, 40)}" is not an option of ${f.name}`);
    return o.id;
  });
}

function condition(col: Col, op: FilterOperator, value: unknown, p: Params): string {
  const f = col.field, e = col.sql;
  if (!opsFor(f).includes(op)) throw new ValueError(`Operator ${op} is not supported for ${f.type} fields`);
  const isText = col.kind === 'text' && f.type !== 'single_select';
  switch (op) {
    case 'is_empty':
      if (f.type === 'attachment') return `NOT EXISTS (SELECT 1 FROM attachments a WHERE a.record_id = r.id AND a.field_id = '${f.id}' AND a.deleted_at IS NULL)`;
      return isText ? `(${e} IS NULL OR ${e} = '')` : `${e} IS NULL`;
    case 'is_not_empty':
      if (f.type === 'attachment') return `EXISTS (SELECT 1 FROM attachments a WHERE a.record_id = r.id AND a.field_id = '${f.id}' AND a.deleted_at IS NULL)`;
      return isText ? `(${e} IS NOT NULL AND ${e} <> '')` : `${e} IS NOT NULL`;
    case 'is_true': return `${rawText(f)} = 'true'`;
    case 'is_false': return `${rawText(f)} = 'false'`;
    case 'has_any': case 'has_all': case 'has_none': {
      const ids = p.add(optionIds(f, value));
      if (f.type === 'single_select') {
        if (op === 'has_any') return `${e} = ANY(${ids}::text[])`;
        if (op === 'has_none') return `(${e} IS NULL OR NOT (${e} = ANY(${ids}::text[])))`;
        throw new ValueError('has_all is not supported for single select');
      }
      if (op === 'has_any') return `${e} ?| ${ids}::text[]`;
      if (op === 'has_all') return `${e} ?& ${ids}::text[]`;
      return `(${e} IS NULL OR NOT (${e} ?| ${ids}::text[]))`;
    }
    case 'contains': case 'not_contains': case 'starts_with': {
      const s = coerceScalar(f, value);
      const pat = op === 'starts_with' ? `${escLike(s)}%` : `%${escLike(s)}%`;
      const ph = p.add(pat);
      if (op === 'not_contains') return `(${e} IS NULL OR ${e} NOT ILIKE ${ph} ESCAPE '\\')`;
      return `${e} ILIKE ${ph} ESCAPE '\\'`;
    }
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': {
      if (col.kind === 'numeric' && (op === 'eq' || op === 'neq')) {
        // exact text equality on the canonical stored form: leakproof, so a text expression index can serve it behind RLS
        let canon: string | null = null;
        try { canon = canonicalDecimal(value, numericScale(f)); } catch { canon = null; } // more precision than the field stores => can never match
        if (canon === null) return op === 'eq' ? 'FALSE' : 'TRUE';
        return `${rawText(f)} ${op === 'eq' ? '=' : 'IS DISTINCT FROM'} ${p.add(canon)}::text`;
      }
      let ph: string;
      if (f.type === 'single_select') ph = p.add(optionIds(f, value)[0]);
      else if (col.kind === 'numeric') ph = `${p.add(coerceScalar(f, value))}::numeric`;
      else if (col.kind === 'timestamptz' && (f.type === 'created_time' || f.type === 'modified_time')) ph = `${p.add(coerceScalar(f, value))}::timestamptz`;
      else ph = `${p.add(coerceScalar(f, value))}::text`;
      const sym = { eq: '=', neq: 'IS DISTINCT FROM', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      return `${e} ${sym} ${ph}`;
    }
  }
}

function countNodes(n: FilterNode, depth: number, acc: { n: number }) {
  if (depth > LIMITS.maxFilterDepth) throw unprocessable(`Filters can be nested at most ${LIMITS.maxFilterDepth} levels deep`);
  acc.n++;
  if (acc.n > LIMITS.maxFilterConditions * 2) throw unprocessable('Filter is too large');
  if ('and' in n) n.and.forEach((x) => countNodes(x, depth + 1, acc));
  else if ('or' in n) n.or.forEach((x) => countNodes(x, depth + 1, acc));
}

function filterSql(n: FilterNode, fields: Map<string, FieldRow>, p: Params, errors: { field: string; message: string }[]): string {
  if ('and' in n || 'or' in n) {
    const kids = ('and' in n ? n.and : n.or).map((x) => filterSql(x, fields, p, errors)).filter(Boolean);
    if (!kids.length) return '';
    return `(${kids.join('and' in n ? ' AND ' : ' OR ')})`;
  }
  const f = fields.get(n.field);
  if (!f) { errors.push({ field: n.field, message: 'Unknown field' }); return ''; }
  try { return `(${condition(colOf(f), n.op, n.value, p)})`; }
  catch (e) { if (e instanceof ValueError) { errors.push({ field: n.field, message: e.message }); return ''; } throw e; }
}

export interface BuiltQuery {
  where: string;
  params: unknown[];
  orderBy: string;
  sortCols: { sql: string; dir: 'asc' | 'desc'; kind: string }[];
  selectSort: string;
  cursorCond: (cursor: CursorPayload | null, p: Params) => string;
  selectValues: string;
  projection: Set<string> | undefined;
}

interface CursorPayload { v: (string | number | boolean | null)[]; s: number; h: string; d?: 'f' | 'b' }

function encodeCursor(secret: string, c: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  return `${body}.${hmac(secret, body).slice(0, 22)}`;
}
function decodeCursor(secret: string, s: string): CursorPayload {
  const [body, sig] = s.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body).slice(0, 22))) throw new HttpError(400, 'bad_cursor', 'Invalid cursor');
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw new HttpError(400, 'bad_cursor', 'Invalid cursor'); }
}

const CAST: Record<string, string> = { text: 'text', numeric: 'numeric', boolean: 'boolean', timestamptz: 'timestamptz', int: 'int' };

export interface QueryResult {
  records: ApiRecord[];
  /** Cursor for the page after this one (null at the end). */
  next_cursor: string | null;
  /** Cursor for the page before this one (null at the start). Lets clients keep a bounded window of pages in memory. */
  prev_cursor: string | null;
  total?: number;
  total_capped?: boolean;
}

/** Plain-object view of the SQL the planner should see; exported for EXPLAIN tooling and tests. */
export function buildQuery(fields: FieldRow[], q: QueryInput, secretForHash: string, opts: { extraWhere?: string; reverse?: boolean } = {}): { b: BuiltQuery; filterParams: Params; sortHash: string } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const p = new Params();
  p.add(null); // $1 reserved for table_id
  const errors: { field: string; message: string }[] = [];
  const clauses: string[] = ['r.table_id = $1'];

  if (q.filter) {
    countNodes(q.filter, 1, { n: 0 });
    const s = filterSql(q.filter, byId, p, errors);
    if (s) clauses.push(s);
  }
  if (q.search?.trim()) {
    const term = q.search.trim().toLowerCase();
    const ph = p.add(`%${escLike(term)}%`);
    const alts = [`r.search_text ~~~ ${ph}`];
    for (const f of fields) {
      if (f.type !== 'single_select' && f.type !== 'multi_select') continue;
      const ids = ((f.options.options ?? []) as SelectOption[]).filter((o) => o.name.toLowerCase().includes(term)).map((o) => o.id);
      if (!ids.length) continue;
      const idp = p.add(ids);
      alts.push(f.type === 'single_select' ? `${rawText(f)} = ANY(${idp}::text[])` : `(r."values"->'${f.id}') ?| ${idp}::text[]`);
    }
    clauses.push(`(${alts.join(' OR ')})`);
  }
  if (opts.extraWhere) clauses.push(opts.extraWhere);

  const sortCols: BuiltQuery['sortCols'] = [];
  for (const s of q.sort ?? []) {
    const f = byId.get(s.field);
    if (!f) { errors.push({ field: s.field, message: 'Unknown sort field' }); continue; }
    if (f.type === 'attachment' || f.type === 'multi_select') { errors.push({ field: s.field, message: `Cannot sort by ${f.type} fields` }); continue; }
    const col = colOf(f);
    if (f.type === 'single_select') {
      const ids = ((f.options.options ?? []) as SelectOption[]).map((o) => `'${o.id.replace(/[^a-z0-9_]/gi, '')}'`);
      sortCols.push({ sql: ids.length ? `array_position(ARRAY[${ids.join(',')}]::text[], ${col.sql})` : 'NULL::int', dir: s.direction, kind: 'int' });
    } else sortCols.push({ sql: col.sql, dir: s.direction, kind: col.kind === 'timestamptz' ? 'timestamptz' : col.kind });
  }
  if (errors.length) throw unprocessable('Invalid query', errors);
  const sortHash = hmac(secretForHash, JSON.stringify((q.sort ?? []).map((s) => [s.field, s.direction])) + JSON.stringify(q.filter ?? null) + (q.search ?? '')).slice(0, 10);
  // A backward page is the same keyset query with every direction flipped (ASC NULLS LAST <-> DESC NULLS FIRST is an exact
  // mirror), whose rows are then reversed. The hash above is computed on the un-flipped spec so both directions share cursors.
  if (opts.reverse) for (const sc of sortCols) sc.dir = sc.dir === 'asc' ? 'desc' : 'asc';
  // ASC => NULLS LAST, DESC => NULLS FIRST (Postgres defaults) so ONE btree index serves both directions; the seq tie-break
  // follows the first sort key's direction for the same reason.
  const tieDir = (sortCols[0] ? sortCols[0].dir === 'desc' : !!opts.reverse) ? 'DESC' : 'ASC';
  const orderBy = [...sortCols.map((s) => `${s.sql} ${s.dir === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST'}`), `r.seq ${tieDir}`].join(', ');
  const selectSort = sortCols.map((s, i) => `${s.sql} AS sk${i}`).join(', ');

  let projection: Set<string> | undefined;
  let selectValues = 'r."values"';
  if (q.fields) {
    projection = new Set<string>();
    for (const id of q.fields) {
      if (!byId.has(id)) throw unprocessable('Invalid query', [{ field: id, message: 'Unknown field in projection' }]);
      projection.add(id);
    }
    const stored = [...projection].filter((id) => !['created_time', 'modified_time', 'attachment'].includes(byId.get(id)!.type));
    selectValues = stored.length ? `jsonb_build_object(${stored.map((id) => `'${id}', r."values"->'${id}'`).join(', ')})` : `'{}'::jsonb`;
  }

  const cursorCond = (cur: CursorPayload | null, params: Params): string => {
    if (!cur) return '';
    if (cur.h !== sortHash || !Array.isArray(cur.v) || cur.v.length !== sortCols.length || typeof cur.s !== 'number') throw new HttpError(400, 'bad_cursor', 'Cursor does not match this query');
    const ors: string[] = [];
    const eqs: string[] = [];
    sortCols.forEach((sc, i) => {
      const val = cur.v[i] ?? null;
      const cast = CAST[sc.kind] ?? 'text';
      let after: string, eq: string;
      if (val === null) { after = sc.dir === 'asc' ? 'FALSE' : `${sc.sql} IS NOT NULL`; eq = `${sc.sql} IS NULL`; }
      else {
        const ph = `${params.add(val)}::${cast}`;
        after = sc.dir === 'asc' ? `(${sc.sql} > ${ph} OR ${sc.sql} IS NULL)` : `${sc.sql} < ${ph}`;
        eq = `${sc.sql} = ${ph}`;
      }
      ors.push([...eqs, after].join(' AND '));
      eqs.push(eq);
    });
    ors.push([...eqs, `r.seq ${tieDir === 'ASC' ? '>' : '<'} ${params.add(cur.s)}`].join(' AND '));
    return `(${ors.map((x) => `(${x})`).join(' OR ')})`;
  };

  return { b: { where: clauses.join(' AND '), params: p.values, orderBy, sortCols, selectSort, cursorCond, selectValues, projection }, filterParams: p, sortHash };
}

export const TOTAL_CAP = 100_000;

/** Compile a query to SQL + params without running it (used by runQuery and by EXPLAIN tooling). */
export function compileQuery(tableId: string, fields: FieldRow[], q: QueryInput, secret: string, defaultLimit = LIMITS.defaultPageSize) {
  const limit = q.limit ?? defaultLimit;
  const cur = q.cursor ? decodeCursor(secret, q.cursor) : null;
  const backward = cur?.d === 'b';
  const { b, filterParams, sortHash } = buildQuery(fields, q, secret, { reverse: backward });
  const params = filterParams;
  params.values[0] = tableId;
  const filterWhere = b.where;
  const countParams = params.values.slice();
  const cursorSql = b.cursorCond(cur, params);
  const where = cursorSql ? `${filterWhere} AND ${cursorSql}` : filterWhere;
  const sql = `SELECT r.id, r.seq, r.version, ${b.selectValues} AS "values", r.created_at, r.updated_at, r.created_by, r.updated_by${b.selectSort ? ', ' + b.selectSort : ''}
     FROM records r WHERE ${where} ORDER BY ${b.orderBy} LIMIT ${limit + 1}`;
  return { sql, params: params.values, limit, cur, backward, b, sortHash, filterWhere, countParams };
}

export async function runQuery(c: Client, tableId: string, fields: FieldRow[], q: QueryInput, secret: string, defaultLimit = LIMITS.defaultPageSize): Promise<QueryResult> {
  const { sql, params, limit, cur, backward, b, sortHash, filterWhere, countParams } = compileQuery(tableId, fields, q, secret, defaultLimit);
  const res = await c.query(sql, params);
  const rows = res.rows as (RecordRow & Record<string, unknown>)[];
  const hasMore = rows.length > limit;
  let page = hasMore ? rows.slice(0, limit) : rows;
  if (backward) page = page.reverse();
  const attachments = await loadAttachments(c, page.map((r) => r.id), fields);
  const out: QueryResult = { records: page.map((r) => toApi(r, fields, attachments, b.projection)), next_cursor: null, prev_cursor: null };
  const cursorOf = (row: RecordRow & Record<string, unknown>, d: 'f' | 'b') => {
    const v = b.sortCols.map((_, i) => {
      const x = row[`sk${i}`];
      return x instanceof Date ? x.toISOString() : ((x ?? null) as string | number | boolean | null);
    });
    return encodeCursor(secret, { v, s: row.seq, h: sortHash, d });
  };
  if (page.length) {
    const first = page[0]!, last = page[page.length - 1]!;
    if (backward) {
      out.next_cursor = cursorOf(last, 'f');                 // we arrived from later rows
      out.prev_cursor = hasMore ? cursorOf(first, 'b') : null;
    } else {
      out.next_cursor = hasMore ? cursorOf(last, 'f') : null;
      out.prev_cursor = cur ? cursorOf(first, 'b') : null;   // a forward page that started from a cursor has rows before it
    }
  }
  if (q.include_total) {
    const t = await c.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM records r WHERE ${filterWhere} LIMIT ${TOTAL_CAP + 1}) x`, countParams);
    const n = t.rows[0].n as number;
    out.total = Math.min(n, TOTAL_CAP);
    out.total_capped = n > TOTAL_CAP;
  }
  return out;
}

/** Iterate every record matching the query in bounded batches (exports). Runs each batch via `runBatch` so the caller controls the transaction. */
export async function* iterateQuery(
  runBatch: <T>(fn: (c: Client) => Promise<T>) => Promise<T>, tableId: string, fields: FieldRow[], q: QueryInput, secret: string, batch = 1000, maxRows = Infinity,
): AsyncGenerator<ApiRecord> {
  let cursor: string | undefined;
  let n = 0;
  for (;;) {
    const res = await runBatch((c) => runQuery(c, tableId, fields, { ...q, cursor, limit: batch, include_total: false }, secret));
    for (const r of res.records) { if (n++ >= maxRows) return; yield r; }
    if (!res.next_cursor) return;
    cursor = res.next_cursor;
  }
}
