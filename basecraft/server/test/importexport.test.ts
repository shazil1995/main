import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { Worker, newApp, signup, tableFixture, type Fixture, type Session } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp, s: Session, worker: Worker;
const P = '/api/v1';
beforeAll(async () => { app = await newApp({ MAX_IMPORT_ROWS: '5000', IMPORT_BATCH_ROWS: '50' }); worker = new Worker(app.ctx, app.fastify.log); s = await signup(app, 'Imp'); });
afterAll(async () => { app.ctx.hooks = undefined; await app.fastify.close(); await app.ctx.db.close(); });

let fx: Fixture;
const imp = (csv: string, mapping: unknown, options: unknown = {}, table = fx.table) =>
  s.upload(`${P}/tables/${table}/imports`, [{ name: 'mapping', value: JSON.stringify(mapping) }, { name: 'options', value: JSON.stringify(options) }, { name: 'file', filename: 'data.csv', content: csv, type: 'text/csv' }]);
const job = async (id: string) => (await s.get(`${P}/imports/${id}`)).body;
const count = async (table = fx.table) => (await s.post(`${P}/tables/${table}/records/query`, { include_total: true, limit: 1 })).body.total;
const all = async (table = fx.table) => { const out: any[] = []; let cursor: string | undefined; do { const r = await s.post(`${P}/tables/${table}/records/query`, { limit: 500, cursor }); out.push(...r.body.records); cursor = r.body.next_cursor; } while (cursor); return out; };

describe('CSV import', () => {
  beforeAll(async () => { fx = await tableFixture(s, 'Imports'); });
  const map = () => [{ column: 0, field: fx.f.name }, { column: 1, field: fx.f.qty }, { column: 2, field: fx.f.price }, { column: 3, field: fx.f.status }, { column: 4, field: fx.f.done }, { column: 5, field: fx.f.tags }, { column: 6, field: fx.f.due }];

  it('previews headers, sample rows, a suggested mapping and per-row validation without storing anything', async () => {
    const csv = 'Name,Qty,Price,Status,Done,Tags,Due\nA,1,"1,299.50",Quote,yes,LED;Neon,2026-01-05\nB,x,3,Nope,maybe,Foo,2026-02-30\n';
    const r = await s.upload(`${P}/tables/${fx.table}/imports/preview`, [{ name: 'mapping', value: JSON.stringify(map()) }, { name: 'file', filename: 'p.csv', content: csv }]);
    expect(r.status).toBe(200);
    expect(r.body.header).toEqual(['Name', 'Qty', 'Price', 'Status', 'Done', 'Tags', 'Due']);
    expect(r.body.row_count).toBe(2);
    expect(r.body.suggested_mapping.find((m: any) => m.column === 0).field).toBe(fx.f.name);
    expect(r.body.suggested_mapping.find((m: any) => m.column === 1).field).toBe(fx.f.qty);
    const bad = r.body.errors.map((e: any) => `${e.row}:${e.column}`);
    expect(bad).toEqual(expect.arrayContaining(['2:1', '2:3', '2:4', '2:5', '2:6']));
    expect(r.body.errors.some((e: any) => e.row === 1)).toBe(false);
    expect(await count()).toBe(0);
  });

  it('imports with explicit type conversions (thousands separators, yes/no, multi-select lists)', async () => {
    const csv = 'Name,Qty,Price,Status,Done,Tags,Due\nSign A,1,"1,299.5",Quote,yes,LED;Neon,2026-01-05\nSign B,0,0,Approved,no,,2024-02-29\n';
    const j = await imp(csv, map());
    expect(j.status).toBe(202);
    await worker.drainJobs();
    const done = await job(j.body.id);
    expect(done.status).toBe('done'); expect(done.rows_created).toBe(2); expect(done.rows_total).toBe(2);
    const recs = await all();
    const a = recs.find((r) => r.fields[fx.f.name!] === 'Sign A')!, b = recs.find((r) => r.fields[fx.f.name!] === 'Sign B')!;
    expect(a.fields[fx.f.price!]).toBe('1299.50'); expect(a.fields[fx.f.done!]).toBe(true); expect(a.fields[fx.f.tags!]).toHaveLength(2);
    expect(b.fields[fx.f.qty!]).toBe(0); expect(b.fields[fx.f.done!]).toBe(false); expect(b.fields[fx.f.price!]).toBe('0.00'); expect(fx.f.tags! in b.fields).toBe(false);
    expect((await s.get(`${P}/workspaces/${fx.ws}/audit?action=import`)).body.events.length).toBeGreaterThan(0);
  });

  it('aborts before writing anything when rows are invalid (default), with a row-level report', async () => {
    const before = await count();
    const csv = 'Name,Qty\nok,1\nbad,1.5\nbad2,abc\n';
    const j = await imp(csv, [{ column: 0, field: fx.f.name }, { column: 1, field: fx.f.qty }]);
    await worker.drainJobs();
    const d = await job(j.body.id);
    expect(d.status).toBe('failed'); expect(d.rows_failed).toBe(2);
    expect(d.errors.map((e: any) => e.row)).toEqual([2, 3]);
    expect(d.last_error).toMatch(/Nothing was imported/);
    expect(await count()).toBe(before);
  });

  it('skip_rows imports the valid rows and reports the rest', async () => {
    const before = await count();
    const j = await imp('Name,Qty\nok1,1\nbad,1.5\nok2,2\n', [{ column: 0, field: fx.f.name }, { column: 1, field: fx.f.qty }], { on_error: 'skip_rows' });
    await worker.drainJobs();
    const d = await job(j.body.id);
    expect(d.status).toBe('done'); expect(d.rows_created).toBe(2); expect(d.rows_failed).toBe(1);
    expect(await count()).toBe(before + 2);
  });

  it('validate_only never writes', async () => {
    const before = await count();
    const j = await imp('Name,Qty\nx,1\ny,2\n', [{ column: 0, field: fx.f.name }, { column: 1, field: fx.f.qty }], { validate_only: true });
    await worker.drainJobs();
    expect((await job(j.body.id)).status).toBe('done');
    expect(await count()).toBe(before);
  });

  it('applies duplicate policies create / skip / update', async () => {
    const t = await tableFixture(s, 'Dupes');
    const m = [{ column: 0, field: t.f.name }, { column: 1, field: t.f.qty }];
    const run = async (csv: string, options: unknown) => { const j = await imp(csv, m, options, t.table); await worker.drainJobs(); return job(j.body.id); };
    await run('Name,Qty\nacme,1\nglobex,2\n', {});
    expect(await count(t.table)).toBe(2);
    const skip = await run('Name,Qty\nacme,100\ninitech,3\nacme,101\n', { duplicate_policy: 'skip', match_field: t.f.name });
    expect(skip.rows_created).toBe(1); expect(skip.rows_skipped).toBe(2);
    let recs = await all(t.table);
    expect(recs.find((r) => r.fields[t.f.name!] === 'acme').fields[t.f.qty!]).toBe(1);
    const upd = await run('Name,Qty\nacme,100\nglobex,200\nnewco,5\n', { duplicate_policy: 'update', match_field: t.f.name });
    expect(upd.rows_updated).toBe(2); expect(upd.rows_created).toBe(1);
    recs = await all(t.table);
    expect(recs).toHaveLength(4);
    expect(recs.find((r) => r.fields[t.f.name!] === 'acme').fields[t.f.qty!]).toBe(100);
    expect(recs.find((r) => r.fields[t.f.name!] === 'acme').version).toBe(2);
    // duplicates inside one file merge instead of creating twice
    const inFile = await run('Name,Qty\nsame,1\nsame,2\n', { duplicate_policy: 'update', match_field: t.f.name });
    expect(inFile.rows_created).toBe(1);
    expect((await all(t.table)).filter((r) => r.fields[t.f.name!] === 'same')).toHaveLength(1);
  });

  it('rejects malformed CSV, bad mappings, oversize row counts, and non-editors', async () => {
    const bad = await s.upload(`${P}/tables/${fx.table}/imports/preview`, [{ name: 'file', filename: 'x.csv', content: 'a,b\n"unterminated,1\n' }]);
    expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('csv_parse_error');
    expect((await imp('a\n1\n', [{ column: 0, field: fx.f.created }])).status).toBe(422);       // read-only field
    expect((await imp('a\n1\n', [{ column: 0, field: fx.f.name }, { column: 1, field: fx.f.name }])).status).toBe(422); // mapped twice
    expect((await imp('a\n1\n', [{ column: 0, field: fx.f.name }], { duplicate_policy: 'update' })).status).toBe(422);   // match_field missing
    expect((await imp('a\n1\n', [{ column: 0, field: '00000000-0000-4000-8000-000000000000' }])).status).toBe(422);
    const big = 'Name\n' + Array.from({ length: 5100 }, (_, i) => `r${i}`).join('\n');
    const j = await imp(big, [{ column: 0, field: fx.f.name }]); await worker.drainJobs();
    expect((await job(j.body.id)).status).toBe('failed');
    expect((await job(j.body.id)).last_error).toMatch(/limited to 5000 rows/);
    const viewer = await signup(app, 'Other');
    expect((await viewer.upload(`${P}/tables/${fx.table}/imports`, [{ name: 'file', filename: 'x.csv', content: 'a' }])).status).toBe(404);
  });

  it('commits in atomic batches, survives a mid-import crash, and resumes without duplicates', async () => {
    const t = await tableFixture(s, 'Resume');
    const csv = 'Name,Qty\n' + Array.from({ length: 230 }, (_, i) => `row${i},${i}`).join('\n');
    let crashes = 1;
    app.ctx.hooks = { afterImportBatch: (n) => { if (n >= 100 && crashes-- > 0) throw new Error('simulated crash'); } };
    const j = await imp(csv, [{ column: 0, field: t.f.name }, { column: 1, field: t.f.qty }], {}, t.table);
    await expect(worker.drainJobs()).rejects.toThrow(/simulated crash/);
    const mid = await job(j.body.id);
    expect(mid.status).toBe('failed'); expect(mid.checkpoint_row).toBe(100); expect(mid.rows_created).toBe(100);
    expect(await count(t.table)).toBe(100);                                  // whole batches only
    expect((await s.post(`${P}/imports/${j.body.id}/resume`)).status).toBe(202);
    await worker.drainJobs();
    const end = await job(j.body.id);
    expect(end.status).toBe('done'); expect(end.rows_created).toBe(230);
    const recs = await all(t.table);
    expect(recs).toHaveLength(230);
    expect(new Set(recs.map((r) => r.fields[t.f.name!])).size).toBe(230);
    app.ctx.hooks = undefined;
  });

  it('a running job whose worker died (expired lease) is picked up and finished', async () => {
    const t = await tableFixture(s, 'Lease');
    const j = await imp('Name\nl1\nl2\nl3\n', [{ column: 0, field: t.f.name }], {}, t.table);
    await app.ctx.db.owner.query(`UPDATE import_jobs SET status='running', locked_until=now()-interval '1 minute' WHERE id=$1`, [j.body.id]);
    await worker.drainJobs();
    expect((await job(j.body.id)).status).toBe('done');
    expect(await count(t.table)).toBe(3);
  });

  it('can be cancelled', async () => {
    const t = await tableFixture(s, 'Cancel');
    const j = await imp('Name\nc1\n', [{ column: 0, field: t.f.name }], {}, t.table);
    expect((await s.post(`${P}/imports/${j.body.id}/cancel`)).status).toBe(200);
    await worker.drainJobs();
    expect(await count(t.table)).toBe(0);
    expect((await s.post(`${P}/imports/${j.body.id}/cancel`)).status).toBe(409);
  });
});

describe('export', () => {
  let t: Fixture;
  const exp = (body: unknown, who: Session = s, table = t.table) => who.post(`${P}/tables/${table}/export`, body);
  beforeAll(async () => {
    t = await tableFixture(s, 'Exports');
    const rows = Array.from({ length: 2300 }, (_, i) => `n${String(i).padStart(4, '0')},${i % 10 === 0 ? '' : i},${(i % 100) / 4},${i % 2 ? 'Quote' : 'Approved'},"line one\nline two, with comma"`);
    rows.push('"=HYPERLINK(""http://evil"")",1,1,Quote,', '"+cmd|\' /C calc\'!A0",1,1,Quote,', '@SUM(A1),1,1,Quote,', '"\tTabbed",1,1,Quote,', '"-5 widgets",1,1,Quote,', '"quote ""x"", comma",1,1,Quote,');
    const mapping = [{ column: 0, field: t.f.name }, { column: 1, field: t.f.qty }, { column: 2, field: t.f.margin }, { column: 3, field: t.f.status }, { column: 4, field: t.f.notes }];
    const j = await imp('Name,Qty,Margin,Status,Notes\n' + rows.join('\n'), mapping, {}, t.table);
    expect(j.status).toBe(202);
    await worker.drainJobs();
    expect((await job(j.body.id)).status).toBe('done');
  });

  it('exports ALL matching records, not the loaded page, as parseable CSV', async () => {
    const r = await exp({ format: 'csv' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('attachment');
    const rows = parse(r.raw.replace(/^﻿/, ''), { columns: true, relax_column_count: true }) as Record<string, string>[];
    expect(rows).toHaveLength(2306);                                  // 2306 > page size (500) and > batch size (1000)
    expect(new Set(rows.map((x) => x.Name)).size).toBe(2306);
    expect(rows.find((x) => x.Name === 'n0003')!.Status).toBe('Quote');
    expect(rows.find((x) => x.Name === 'n0004')!.Notes).toBe('line one\nline two, with comma');
    expect(rows.find((x) => x.Name === 'n0010')!.Qty).toBe('');            // empty stays empty (not 0)
    expect(rows.find((x) => x.Name === 'n0001')!.Qty).toBe('1');
  });

  it('neutralises spreadsheet formula injection in text cells but leaves real numbers alone', async () => {
    const r = await exp({ format: 'csv', fields: [t.f.name, t.f.qty] });
    const rows = parse(r.raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[];
    const names = new Set(rows.map((x) => x.Name));
    expect(names).toContain(`'=HYPERLINK("http://evil")`);
    expect(names).toContain(`'+cmd|' /C calc'!A0`);
    expect(names).toContain(`'@SUM(A1)`);
    expect(names).toContain(`'\tTabbed`);
    expect(names).toContain(`'-5 widgets`);
    expect(names).toContain(`quote "x", comma`);
    for (const n of names) expect(/^[=+\-@\t\r]/.test(n ?? "")).toBe(false);
    // a negative NUMBER must stay a number
    const neg = await s.post(`${P}/tables/${t.table}/records`, { fields: { [t.f.name!]: 'neg', [t.f.qty!]: -7, [t.f.margin!]: '-1.50' } });
    expect(neg.status).toBe(201);
    const again = parse((await exp({ format: 'csv', fields: [t.f.name, t.f.qty, t.f.margin], query: { search: 'neg' } })).raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[];
    expect(again).toEqual([{ Name: 'neg', Qty: '-7', Margin: '-1.50' }]);
    // header cells are protected too
    const sneaky = (await s.post(`${P}/tables/${t.table}/fields`, { name: '=evil()', type: 'text' })).body.id;
    const hdr = (await exp({ format: 'csv', fields: [sneaky] })).raw.replace(/^﻿/, '').split('\r\n')[0];
    expect(hdr).toBe(`'=evil()`);
  });

  it('applies filters, sorts and saved views to the full export', async () => {
    const r = await exp({ format: 'csv', query: { filter: { field: t.f.status, op: 'eq', value: 'Quote' }, sort: [{ field: t.f.name, direction: 'desc' }] }, fields: [t.f.name, t.f.status] });
    const rows = parse(r.raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[];
    expect(rows.length).toBeGreaterThan(1100);
    expect(rows.every((x) => x.Status === 'Quote')).toBe(true);
    const seq = rows.map((x) => x.Name).filter((n): n is string => /^n\d{4}$/.test(n ?? ''));
    expect(seq.length).toBeGreaterThan(1000);
    expect(seq.every((n, i) => i === 0 || seq[i - 1]! > n)).toBe(true);                // strictly descending
    const view = await s.post(`${P}/tables/${t.table}/views`, { name: 'Approved only', type: 'grid', visibility: 'shared', config: { filter: { field: t.f.status, op: 'eq', value: 'Approved' } } });
    const v = parse((await exp({ format: 'csv', query: { view_id: view.body.id }, fields: [t.f.status] })).raw.replace(/^﻿/, ''), { columns: true }) as Record<string, string>[];
    expect(v).toHaveLength(1150); expect(v.every((x) => x.Status === 'Approved')).toBe(true);
  });

  it('exports JSON with the schema and records', async () => {
    const r = await exp({ format: 'json', query: { search: 'n0007' } });
    expect(r.status).toBe(200);
    const j = JSON.parse(r.raw);
    expect(j.fields.find((f: any) => f.name === 'Qty').type).toBe('integer');
    expect(j.records).toHaveLength(1); expect(j.records[0].fields[t.f.name!]).toBe('n0007');
  });

  it('round-trips: export then import into a fresh table reproduces the data', async () => {
    const r = await exp({ format: 'csv', fields: [t.f.name, t.f.qty, t.f.margin, t.f.status] });
    const csv = r.raw.replace(/^﻿/, '').replace(/'(?=[=+@\t])/g, '').replace(/^'-/gm, '-');
    const t2 = await tableFixture(s, 'RoundTrip');
    const mapping = [{ column: 0, field: t2.f.name }, { column: 1, field: t2.f.qty }, { column: 2, field: t2.f.margin }, { column: 3, field: t2.f.status }];
    const j = await imp(csv.replace(/\r\n/g, '\n'), mapping, { on_error: 'skip_rows' }, t2.table);
    await worker.drainJobs();
    const done = await job(j.body.id);
    expect(done.status).toBe('done');
    const a = new Map((await all(t.table)).map((x) => [x.fields[t.f.name!], x])), b = new Map((await all(t2.table)).map((x) => [x.fields[t2.f.name!], x]));
    for (const name of ['n0000', 'n0001', 'n0999', 'n2299']) {
      const x = a.get(name)!.fields, y = b.get(name)!.fields;
      expect(y[t2.f.qty!]).toEqual(x[t.f.qty!]); expect(y[t2.f.margin!]).toEqual(x[t.f.margin!]);
    }
    expect(b.size).toBeGreaterThanOrEqual(2290);
  });

  it('requires the export permission, records an audit event, and labels scope', async () => {
    const other = await signup(app, 'Nope');
    expect((await exp({ format: 'csv' }, other)).status).toBe(404);
    expect((await exp({ format: 'csv', fields: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(422);
    await exp({ format: 'csv', query: { search: 'n0001' } });
    const ev = (await s.get(`${P}/workspaces/${t.ws}/audit?action=records.export&limit=5`)).body.events;
    expect(ev[0].metadata.scope).toBe('all-matching'); expect(ev[0].metadata.rows).toBeGreaterThan(0);
  });
});
