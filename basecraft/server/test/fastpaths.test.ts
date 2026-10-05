import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileQuery } from '../src/query.js';
import { loadFields } from '../src/records.js';
import { withWorkspace } from '../src/db.js';
import { newApp, signup, tableFixture, type Fixture, type Session } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp, s: Session, fx: Fixture, provisioned = false;
const P = '/api/v1';
beforeAll(async () => {
  app = await newApp(); s = await signup(app, 'Perf'); fx = await tableFixture(s, 'Fast paths');
  provisioned = (await app.ctx.db.owner.query(`SELECT proleakproof FROM pg_proc WHERE proname='bc_jtext'`)).rows[0]?.proleakproof === true;
  const mk = (i: number) => ({ fields: { [fx.f.name!]: `sign ${i} ${['harbor', 'summit', 'maple'][i % 3]}`, [fx.f.qty!]: i % 2000, [fx.f.margin!]: `${i % 500}.25`, [fx.f.status!]: ['Quote', 'Approved', 'Installed'][i % 3], [fx.f.done!]: i % 2 === 0, [fx.f.due!]: `2026-0${(i % 9) + 1}-15` } });
  for (let i = 0; i < 6000; i += 100) expect((await s.post(`${P}/tables/${fx.table}/records`, { records: Array.from({ length: 100 }, (_, k) => mk(i + k)) })).status).toBe(201);
  await app.ctx.db.owner.query('ANALYZE records');
}, 120_000);
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

const q = (body: unknown) => s.post(`${P}/tables/${fx.table}/records/query`, body);
async function plan(query: any): Promise<string> {
  return withWorkspace(app.ctx.db, fx.ws, async (c) => {
    const fields = await loadFields(c, fx.table);
    const cq = compileQuery(fx.table, fields, query, app.ctx.config.SERVER_SECRET);
    // test-scale tables are small enough for the planner to prefer a seq scan on cost; we assert the index is USABLE (if it were not, a seq scan would still be forced)
    await c.query('SET LOCAL enable_seqscan = off');
    return (await c.query(`EXPLAIN (COSTS OFF) ${cq.sql}`, cq.params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('exact numeric equality (canonical text form)', () => {
  it('matches the stored canonical value regardless of how the number is written', async () => {
    const a = (await q({ filter: { field: fx.f.margin, op: 'eq', value: '7.25' }, limit: 500 })).body.records.length;
    expect(a).toBe(12);
    expect((await q({ filter: { field: fx.f.margin, op: 'eq', value: 7.25 }, limit: 500 })).body.records.length).toBe(12);
    expect((await q({ filter: { field: fx.f.margin, op: 'eq', value: '7.250' }, limit: 500 })).body.records.length).toBe(12);
    expect((await q({ filter: { field: fx.f.qty, op: 'eq', value: '777' }, limit: 500 })).body.records.length).toBe(3);
  });
  it('more precision than the field stores can never match (and neq matches everything)', async () => {
    expect((await q({ filter: { field: fx.f.margin, op: 'eq', value: '7.255' }, limit: 5 })).body.records).toHaveLength(0);
    expect((await q({ filter: { field: fx.f.margin, op: 'neq', value: '7.255' }, limit: 5, include_total: true })).body.total).toBe(6000);
  });
  it('checkbox true/false/empty are three different sets', async () => {
    const n = async (op: string) => (await q({ filter: { field: fx.f.done, op }, limit: 1, include_total: true })).body.total;
    expect(await n('is_true')).toBe(3000); expect(await n('is_false')).toBe(3000); expect(await n('is_empty')).toBe(0);
  });
});

describe.skipIf(false)('index use behind row-level security', () => {
  it('reports whether the superuser-provisioned fast paths are present', () => { console.log(`[fast paths provisioned: ${provisioned}]`); expect(typeof provisioned).toBe('boolean'); });

  it('substring search is backed by a trigram index on a LEAKPROOF operator when provisioned (plan proof at 100k rows: bench/raw/explain.txt)', async () => {
    if (!provisioned) return;
    const cat = (await app.ctx.db.owner.query(`SELECT p.proleakproof AS leakproof, (SELECT indexdef FROM pg_indexes WHERE indexname='records_search_idx') AS idx
      FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode WHERE o.oprname = '~~~'`)).rows[0];
    expect(cat.leakproof).toBe(true);
    expect(cat.idx).toMatch(/USING gin \(search_text bc_trgm_ops\)/);
    expect((await q({ search: 'sign 4242 ', limit: 10 })).body.records).toHaveLength(1);
  });
  it('a rare-value equality filter uses the field index when provisioned', async () => {
    if (!provisioned) return;
    expect((await s.patch(`${P}/fields/${fx.f.qty}`, { indexed: true })).status).toBe(200);
    await app.ctx.db.owner.query('ANALYZE records');
    const p = await plan({ filter: { field: fx.f.qty, op: 'eq', value: 777 }, limit: 100 });
    expect(p).toMatch(/Index Cond: \(bc_jtext\(/);
    expect(p).not.toMatch(/Seq Scan/);
    const rows = await q({ filter: { field: fx.f.qty, op: 'eq', value: 777 }, limit: 100 });
    expect(rows.body.records).toHaveLength(3);
  });
  it('ORDER BY on an indexed numeric field walks the index in both directions', async () => {
    if (!provisioned) return;
    for (const direction of ['asc', 'desc'] as const) {
      const p = await plan({ sort: [{ field: fx.f.qty, direction }], limit: 100 });
      expect(p).toMatch(/Index Scan/);
      expect(p).not.toMatch(/Sort\b/);
    }
    const asc = (await q({ sort: [{ field: fx.f.qty, direction: 'asc' }], limit: 5 })).body.records.map((r: any) => r.fields[fx.f.qty!]);
    expect(asc).toEqual([0, 0, 0, 1, 1]);
  });
  it('turning the index off removes both indexes', async () => {
    expect((await s.patch(`${P}/fields/${fx.f.qty}`, { indexed: false })).status).toBe(200);
    const left = await app.ctx.db.owner.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname LIKE $1`, [`rx\\_${fx.table.replace(/-/g, '').slice(0, 12)}\\_${fx.f.qty!.replace(/-/g, '').slice(0, 12)}\\_%`]);
    expect(left.rows[0].n).toBe(0);
  });
});
