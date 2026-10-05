import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp, signup, tableFixture, type Fixture, type Session } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp, s: Session, fx: Fixture;
beforeAll(async () => { app = await newApp(); s = await signup(app, 'Ada'); fx = await tableFixture(s); });
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

const rec = (over: Record<string, unknown> = {}) => ({ fields: { [fx.f.name!]: 'Lobby sign', ...over } });

describe('records: create, reload, typed values', () => {
  it('persists every field type and returns it after reload', async () => {
    const f = fx.f;
    const r = await s.post(`/api/v1/tables/${fx.table}/records`, { fields: {
      [f.name!]: 'Lobby sign', [f.notes!]: 'line1\nline2', [f.qty!]: 0, [f.margin!]: '12.5', [f.price!]: 1999.9, [f.discount!]: '12.5', [f.due!]: '2024-02-29',
      [f.installed!]: '2026-03-08T03:30:00', [f.done!]: false, [f.status!]: 'approved', [f.tags!]: ['LED', 'outdoor'], [f.contact!]: 'a@b.co',
      [f.site!]: 'https://example.com', [f.phone!]: '+92 300 1234567',
    } });
    expect(r.status).toBe(201);
    expect(r.headers.etag).toBe('"1"');
    const got = await s.get(`/api/v1/records/${r.body.id}`);
    expect(got.status).toBe(200);
    const v = got.body.fields;
    expect(v[f.qty!]).toBe(0);                       // zero is a value
    expect(v[f.done!]).toBe(false);                  // false is a value
    expect(v[f.margin!]).toBe('12.50');              // decimals are exact strings
    expect(v[f.price!]).toBe('1999.90');
    expect(v[f.installed!]).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT (after the gap) -> UTC
    expect(v[f.phone!]).toBe('+923001234567');
    expect(v[f.tags!]).toHaveLength(2);
    expect(v[f.created!]).toBe(got.body.created_time);
    expect(v[f.notes!]).toBe('line1\nline2');
    expect(v[f.files!]).toEqual([]);
  });

  it('keeps null/empty distinct from false and zero', async () => {
    const r = await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [fx.f.qty!]: 0, [fx.f.done!]: false, [fx.f.notes!]: '', [fx.f.margin!]: null }));
    const v = r.body.fields;
    expect(fx.f.qty! in v).toBe(true);
    expect(v[fx.f.done!]).toBe(false);
    expect(fx.f.notes! in v).toBe(false);
    expect(fx.f.margin! in v).toBe(false);
  });

  it('reports every invalid field at once with useful messages', async () => {
    const r = await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [fx.f.qty!]: 1.5, [fx.f.contact!]: 'nope', [fx.f.due!]: '2026-02-30', [fx.f.discount!]: '101', [fx.f.installed!]: '2026-03-08T02:30:00', 'bad-field': 1, [fx.f.created!]: 'x' }));
    expect(r.status).toBe(422);
    const bad = new Map(r.body.error.details.map((d: any) => [d.field, d.message]));
    expect(bad.get(fx.f.qty!)).toMatch(/whole number/);
    expect(bad.get(fx.f.contact!)).toMatch(/email/);
    expect(bad.get(fx.f.due!)).toMatch(/valid date/);
    expect(bad.get(fx.f.discount!)).toMatch(/at most/);
    expect(bad.get(fx.f.installed!)).toMatch(/does not exist/);
    expect(bad.get('bad-field')).toMatch(/Unknown/);
    expect(bad.get(fx.f.created!)).toMatch(/read-only/);
    expect(r.body.error.trace_id).toBeTruthy();
  });

  it('batch create is atomic', async () => {
    const before = (await s.post(`/api/v1/tables/${fx.table}/records/query`, { include_total: true })).body.total;
    const r = await s.post(`/api/v1/tables/${fx.table}/records`, { records: [rec(), rec({ [fx.f.qty!]: 'x' })] });
    expect(r.status).toBe(422);
    expect((await s.post(`/api/v1/tables/${fx.table}/records/query`, { include_total: true })).body.total).toBe(before);
  });
});

describe('optimistic concurrency', () => {
  it('requires a version, rejects stale writes with 412 + current record, and never loses an update', async () => {
    const c = await s.post(`/api/v1/tables/${fx.table}/records`, rec());
    const id = c.body.id;
    expect((await s.patch(`/api/v1/records/${id}`, { fields: { [fx.f.qty!]: 1 } })).status).toBe(428);
    const a = await s.patch(`/api/v1/records/${id}`, { fields: { [fx.f.qty!]: 1 } }, { 'if-match': '"1"' });
    expect(a.status).toBe(200); expect(a.body.version).toBe(2);
    const stale = await s.patch(`/api/v1/records/${id}`, { fields: { [fx.f.qty!]: 2 } }, { 'if-match': '"1"' });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.current.fields[fx.f.qty!]).toBe(1);
    // body.version works too; no-op updates do not bump version
    const same = await s.patch(`/api/v1/records/${id}`, { fields: { [fx.f.qty!]: 1 }, version: 2 });
    expect(same.body.version).toBe(2);
    expect((await s.del(`/api/v1/records/${id}`, { 'if-match': '"1"' })).status).toBe(412);
    expect((await s.del(`/api/v1/records/${id}`, { 'if-match': '"2"' })).status).toBe(204);
    expect((await s.get(`/api/v1/records/${id}`)).status).toBe(404);
  });

  it('concurrent updates of the same version: exactly one wins', async () => {
    const c = await s.post(`/api/v1/tables/${fx.table}/records`, rec());
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.patch(`/api/v1/records/${c.body.id}`, { fields: { [fx.f.qty!]: i } }, { 'if-match': '"1"' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 412)).toHaveLength(7);
  });

  it('PATCH only changes supplied fields', async () => {
    const c = await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [fx.f.qty!]: 5 }));
    const u = await s.patch(`/api/v1/records/${c.body.id}`, { fields: { [fx.f.notes!]: 'hi' } }, { 'if-match': '"1"' });
    expect(u.body.fields[fx.f.qty!]).toBe(5);
    expect(u.body.fields[fx.f.notes!]).toBe('hi');
    const cleared = await s.patch(`/api/v1/records/${c.body.id}`, { fields: { [fx.f.qty!]: null } }, { 'if-match': '"2"' });
    expect(fx.f.qty! in cleared.body.fields).toBe(false);
  });
});

describe('idempotency', () => {
  it('replays the same response for a retried create and rejects key reuse with a different body', async () => {
    const key = 'create-' + Math.random();
    const body = rec({ [fx.f.qty!]: 77 });
    const a = await s.post(`/api/v1/tables/${fx.table}/records`, body, { 'idempotency-key': key });
    const b = await s.post(`/api/v1/tables/${fx.table}/records`, body, { 'idempotency-key': key });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replay']).toBe('true');
    const c = await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [fx.f.qty!]: 78 }), { 'idempotency-key': key });
    expect(c.status).toBe(422); expect(c.body.error.code).toBe('idempotency_key_reuse');
  });
  it('concurrent duplicates create exactly one record', async () => {
    const key = 'race-' + Math.random();
    const body = rec({ [fx.f.qty!]: 4242 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => s.post(`/api/v1/tables/${fx.table}/records`, body, { 'idempotency-key': key })));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    const q = await s.post(`/api/v1/tables/${fx.table}/records/query`, { filter: { field: fx.f.qty!, op: 'eq', value: 4242 }, include_total: true });
    expect(q.body.total).toBe(1);
  });
});

describe('query: filters, sorting, cursor pagination', () => {
  let t2: Fixture;
  beforeAll(async () => {
    t2 = await tableFixture(s, 'Pagination');
    const f = t2.f;
    const records = Array.from({ length: 60 }, (_, i) => ({ fields: {
      [f.name!]: `Sign ${String(i).padStart(2, '0')}`, [f.qty!]: i % 5 === 0 ? undefined : i % 4, [f.margin!]: i % 7 === 0 ? undefined : String((i % 6) + 0.5),
      [f.status!]: ['Quote', 'Approved', 'Installed'][i % 3], [f.tags!]: i % 2 ? ['LED'] : ['Neon', 'Vinyl'], [f.done!]: i % 3 === 0 ? true : i % 3 === 1 ? false : undefined,
      [f.due!]: `2026-0${(i % 9) + 1}-1${i % 9}`, [f.contact!]: `p${i}@example.com`,
    } }));
    for (let i = 0; i < records.length; i += 50) expect((await s.post(`/api/v1/tables/${t2.table}/records`, { records: records.slice(i, i + 50) })).status).toBe(201);
  });
  const q = (body: unknown) => s.post(`/api/v1/tables/${t2.table}/records/query`, body);

  async function walk(body: any): Promise<any[]> {
    const out: any[] = []; let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await q({ ...body, limit: 7, cursor });
      expect(r.status).toBe(200);
      out.push(...r.body.records);
      if (!r.body.next_cursor) return out;
      cursor = r.body.next_cursor;
    }
    throw new Error('cursor loop');
  }

  it('pages every record exactly once with duplicate and null sort values (asc and desc)', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      for (const field of [t2.f.qty!, t2.f.margin!, t2.f.status!, t2.f.done!, t2.f.due!]) {
        const all = await walk({ sort: [{ field, direction: dir }] });
        expect(all).toHaveLength(60);
        expect(new Set(all.map((r) => r.id)).size).toBe(60);
        // ordering is consistent with a single big page
        const big = (await q({ sort: [{ field, direction: dir }], limit: 100 })).body.records;
        expect(all.map((r) => r.id)).toEqual(big.map((r: any) => r.id));
      }
    }
  });
  it('multi-key sorts and filter+sort paginate stably', async () => {
    const body = { sort: [{ field: t2.f.status!, direction: 'asc' }, { field: t2.f.qty!, direction: 'desc' }], filter: { field: t2.f.tags!, op: 'has_any', value: ['led'] } };
    const all = await walk(body);
    expect(all).toHaveLength(30);
    expect(new Set(all.map((r) => r.id)).size).toBe(30);
  });
  it('numeric sort is numeric, nulls last ascending', async () => {
    const r = (await q({ sort: [{ field: t2.f.qty!, direction: 'asc' }], limit: 100 })).body.records.map((x: any) => x.fields[t2.f.qty!]);
    const vals = r.filter((x: any) => x !== undefined);
    expect(vals).toEqual([...vals].sort((a: number, b: number) => a - b));
    expect(r.slice(-12).every((x: any) => x === undefined)).toBe(true);
  });
  it('filter groups with AND/OR/nesting', async () => {
    const r = await q({ filter: { and: [{ field: t2.f.status!, op: 'eq', value: 'Quote' }, { or: [{ field: t2.f.done!, op: 'is_true' }, { field: t2.f.qty!, op: 'gte', value: 3 }] }] }, limit: 100, include_total: true });
    expect(r.status).toBe(200);
    for (const x of r.body.records) {
      expect(x.fields[t2.f.status!]).toBeTruthy();
      expect(x.fields[t2.f.done!] === true || Number(x.fields[t2.f.qty!]) >= 3).toBe(true);
    }
    expect(r.body.total).toBe(r.body.records.length);
  });
  it('is_empty vs eq 0 vs is_false are different', async () => {
    const empty = (await q({ filter: { field: t2.f.qty!, op: 'is_empty' }, limit: 100 })).body.records.length;
    const zero = (await q({ filter: { field: t2.f.qty!, op: 'eq', value: 0 }, limit: 100 })).body.records.length;
    const f = (await q({ filter: { field: t2.f.done!, op: 'is_false' }, limit: 100 })).body.records.length;
    const noCheck = (await q({ filter: { field: t2.f.done!, op: 'is_empty' }, limit: 100 })).body.records.length;
    expect(empty).toBe(12); expect(zero).toBeGreaterThan(0);
    const both = (await q({ filter: { and: [{ field: t2.f.qty!, op: 'is_empty' }, { field: t2.f.qty!, op: 'eq', value: 0 }] }, limit: 100 })).body.records.length;
    expect(both).toBe(0); // a zero is never "empty"
    expect(f).toBe(20); expect(noCheck).toBe(20);
  });
  it('search matches text and select option names; LIKE wildcards are literal', async () => {
    expect((await q({ search: 'sign 07', limit: 100 })).body.records).toHaveLength(1);
    expect((await q({ search: 'p5@example', limit: 100 })).body.records.length).toBeGreaterThan(0);
    expect((await q({ search: 'installed', limit: 100 })).body.records).toHaveLength(20); // select option name
    expect((await q({ search: '%', limit: 100 })).body.records).toHaveLength(0);
    expect((await q({ search: '_', limit: 100 })).body.records).toHaveLength(0);
  });
  it('projects only requested fields and caps page size', async () => {
    const r = await q({ fields: [t2.f.name!], limit: 3 });
    expect(Object.keys(r.body.records[0].fields)).toEqual([t2.f.name!]);
    expect((await q({ limit: 5000 })).status).toBe(422);
  });
  it('rejects tampered cursors, cursor reuse with another query, bad fields and operators', async () => {
    const first = await q({ limit: 2, sort: [{ field: t2.f.qty!, direction: 'asc' }] });
    expect((await q({ limit: 2, cursor: first.body.next_cursor + 'x', sort: [{ field: t2.f.qty!, direction: 'asc' }] })).status).toBe(400);
    expect((await q({ limit: 2, cursor: first.body.next_cursor, sort: [{ field: t2.f.margin!, direction: 'asc' }] })).status).toBe(400);
    expect((await q({ filter: { field: 'zzz', op: 'eq', value: 1 } })).status).toBe(422);
    expect((await q({ filter: { field: t2.f.qty!, op: 'contains', value: '1' } })).status).toBe(422);
    expect((await q({ sort: [{ field: t2.f.tags!, direction: 'asc' }] })).status).toBe(422);
    expect((await q({ filter: { field: t2.f.name!, op: 'eq', value: "x'; DROP TABLE records;--" } })).status).toBe(200);
  });
});

describe('saved views', () => {
  it('saves, lists, applies and enforces view rules', async () => {
    const f = fx.f;
    const v = await s.post(`/api/v1/tables/${fx.table}/views`, { name: 'Active', type: 'grid', visibility: 'shared', config: { filter: { field: f.status!, op: 'eq', value: 'Approved' }, sort: [{ field: f.name!, direction: 'asc' }], hiddenFields: [f.notes!], fieldWidths: { [f.name!]: 300 } } });
    expect(v.status).toBe(201);
    const list = await s.get(`/api/v1/tables/${fx.table}/views`);
    expect(list.body.views.map((x: any) => x.name)).toContain('Active');
    const applied = await s.get(`/api/v1/tables/${fx.table}/records?view_id=${v.body.id}`);
    expect(applied.status).toBe(200);
    for (const r of applied.body.records) expect(r.fields[f.status!]).toBeTruthy();
    expect((await s.post(`/api/v1/tables/${fx.table}/views`, { name: 'Bad', type: 'kanban', config: { kanban: { groupField: f.qty! } } })).status).toBe(422);
    expect((await s.post(`/api/v1/tables/${fx.table}/views`, { name: 'Board', type: 'kanban', config: { kanban: { groupField: f.status! } } })).status).toBe(201);
    expect((await s.post(`/api/v1/tables/${fx.table}/views`, { name: 'Cal', type: 'calendar', config: { calendar: { dateField: f.due! } } })).status).toBe(201);
    expect((await s.post(`/api/v1/tables/${fx.table}/views`, { name: 'Cal2', type: 'calendar', config: { calendar: { dateField: f.name! } } })).status).toBe(422);
    const upd = await s.patch(`/api/v1/views/${v.body.id}`, { name: 'Active 2', version: 1 });
    expect(upd.body.version).toBe(2);
    expect((await s.patch(`/api/v1/views/${v.body.id}`, { name: 'x', version: 1 })).status).toBe(412);
  });
});

describe('schema', () => {
  it('rejects duplicate field names, protects the primary field, and guards select options in use', async () => {
    expect((await s.post(`/api/v1/tables/${fx.table}/fields`, { name: 'name', type: 'text' })).status).toBe(409);
    expect((await s.del(`/api/v1/fields/${fx.f.name!}`)).status).toBe(409);
    await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [fx.f.status!]: 'Quote' }));
    const opts = fx.fields.find((x: any) => x.name === 'Status').options.options;
    const drop = await s.patch(`/api/v1/fields/${fx.f.status!}`, { options: { options: opts.slice(1) } });
    expect(drop.status).toBe(409); expect(drop.body.error.code).toBe('option_in_use');
    const rename = await s.patch(`/api/v1/fields/${fx.f.status!}`, { options: { options: [{ id: opts[0].id, name: 'Quoted' }, ...opts.slice(1)] } });
    expect(rename.status).toBe(200);
  });
  it('soft-deleted fields keep their ids and stored values out of API output', async () => {
    const nf = (await s.post(`/api/v1/tables/${fx.table}/fields`, { name: 'Temp', type: 'text' })).body;
    const r = await s.post(`/api/v1/tables/${fx.table}/records`, rec({ [nf.id]: 'secret-ish' }));
    expect((await s.del(`/api/v1/fields/${nf.id}`)).status).toBe(204);
    const got = await s.get(`/api/v1/records/${r.body.id}`);
    expect(got.body.fields[nf.id]).toBeUndefined();
  });
  it('expression index can be toggled on a field and queries still work', async () => {
    const r = await s.patch(`/api/v1/fields/${fx.f.qty!}`, { indexed: true });
    expect(r.status).toBe(200); expect(r.body.indexed).toBe(true);
    const idx = await app.ctx.db.owner.query(`SELECT indexname FROM pg_indexes WHERE tablename='records' AND indexname LIKE 'rx_%'`);
    expect(idx.rowCount).toBeGreaterThan(0);
    expect((await s.post(`/api/v1/tables/${fx.table}/records/query`, { sort: [{ field: fx.f.qty!, direction: 'desc' }], limit: 5 })).status).toBe(200);
    await s.patch(`/api/v1/fields/${fx.f.qty!}`, { indexed: false });
  });
});
