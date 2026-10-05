/**
 * Reproducible load test. Spawns the BUILT API (node dist/main.js) as a separate process, builds a 100k-record / 20-field fixture
 * through the public batch API, then drives HTTP load with N concurrent keep-alive clients and records EVERY latency.
 * Raw output is kept in bench/raw/. Usage: npm run build -w server && npx tsx scripts/bench.ts [--records 100000] [--clients 20] [--seconds 10]
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import pg from 'pg';

const arg = (n: string, d: number) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const RECORDS = arg('records', 100_000), CLIENTS = arg('clients', 20), SECONDS = arg('seconds', 10), PORT = 4199;
const root = resolve(import.meta.dirname, '..'), rawDir = resolve(root, '../bench/raw');
mkdirSync(rawDir, { recursive: true });
const env = { ...process.env, PORT: String(PORT), WORKER_MODE: 'inline', LOG_LEVEL: 'warn', RATE_LIMIT_TOKEN_PER_MIN: '10000000', RATE_LIMIT_WORKSPACE_PER_MIN: '10000000', RATE_LIMIT_ANON_PER_MIN: '10000000', LOGIN_MAX_FAILURES: '100000', ALLOW_SIGNUP: 'true', DB_POOL_MAX: '10' };
const base = `http://127.0.0.1:${PORT}`;

const srv = spawn('node', ['dist/main.js'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
const rssKb = (pid: number) => { try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]); } catch { return 0; } };
const hwmKb = (pid: number) => { try { return Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]); } catch { return 0; } };
const pgRssMb = () => { try { return Number(execSync(`ps -C postgres -o rss= | awk '{s+=$1} END {print int(s/1024)}'`).toString().trim()); } catch { return -1; } };
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }

let cookie = '', csrf = '';
async function call(method: string, url: string, body?: unknown, tok?: string) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : { cookie, 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text(); const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${method} ${url} ${r.status} ${t.slice(0, 200)}`);
  return j;
}

const email = `bench_${Date.now()}@example.test`;
const su = await call('POST', '/api/v1/auth/signup', { email, name: 'Bench', password: 'benchmark password 1', workspace_name: 'bench' });
csrf = su.csrf_token; const ws = su.workspaces[0].id;
const b = (await call('POST', `/api/v1/workspaces/${ws}/bases`, { name: 'bench' })).id;
const tbl = await call('POST', `/api/v1/bases/${b}/tables`, { name: 'Bench 100k', fields: [
  { name: 'Name', type: 'text' }, { name: 'Notes', type: 'long_text' }, { name: 'Qty', type: 'integer' }, { name: 'Margin', type: 'decimal', options: { scale: 2 } },
  { name: 'Price', type: 'currency', options: { currency: 'USD' } }, { name: 'Discount', type: 'percent', options: { scale: 1 } }, { name: 'Due', type: 'date' },
  { name: 'Installed', type: 'datetime', options: { timezone: 'America/New_York' } }, { name: 'Done', type: 'checkbox' },
  { name: 'Status', type: 'single_select', options: { options: ['Quote', 'Approved', 'In production', 'Installed', 'Invoiced'] } },
  { name: 'Tags', type: 'multi_select', options: { options: ['LED', 'Neon', 'Vinyl', 'Outdoor', 'Indoor', 'Rush'] } },
  { name: 'Contact', type: 'email' }, { name: 'Site', type: 'url' }, { name: 'Phone', type: 'phone' }, { name: 'Region', type: 'single_select', options: { options: ['North', 'South', 'East', 'West'] } },
  { name: 'Owner', type: 'text' }, { name: 'Score', type: 'integer' }, { name: 'Created', type: 'created_time' }, { name: 'Modified', type: 'modified_time' }, { name: 'Files', type: 'attachment' }] });
const F = Object.fromEntries(tbl.fields.map((f: any) => [f.name, f.id]));
const tokRes = await call('POST', `/api/v1/workspaces/${ws}/tokens`, { name: 'bench', scopes: ['records:read', 'records:write', 'records:delete', 'schema:read'] });
const TOKEN = tokRes.token as string;

// ── fixture ──
const words = ['harbor', 'summit', 'maple', 'orchard', 'granite', 'lantern', 'redwood', 'sunrise', 'blue', 'heron', 'north', 'cedar', 'pine', 'atlas', 'vertex', 'monument', 'channel', 'neon', 'vinyl'];
const status = ['Quote', 'Approved', 'In production', 'Installed', 'Invoiced'], region = ['North', 'South', 'East', 'West'], tags = ['LED', 'Neon', 'Vinyl', 'Outdoor', 'Indoor', 'Rush'];
const rec = (i: number) => ({ fields: {
  [F.Name]: `${words[i % words.length]} ${words[(i * 7) % words.length]} sign ${i}`, [F.Notes]: i % 4 === 0 ? `Install note ${i}: needs lift, confirm power and permit` : undefined,
  [F.Qty]: i % 50, [F.Margin]: `${(i % 9000) / 100}`.replace(/^(\d+)$/, '$1.00'), [F.Price]: `${1000 + (i * 37) % 90000}.${String(i % 100).padStart(2, '0')}`, [F.Discount]: String((i % 400) / 10),
  [F.Due]: `20${20 + (i % 7)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, [F.Installed]: `2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, '0')}T10:00:00`,
  [F.Done]: i % 3 === 0, [F.Status]: status[i % 5], [F.Tags]: [tags[i % 6], tags[(i + 2) % 6]], [F.Contact]: `c${i}@example.test`, [F.Site]: `https://example.test/${i}`,
  [F.Phone]: `+1555${String(1000000 + i).slice(-7)}`, [F.Region]: region[i % 4], [F.Owner]: `owner${i % 200}`, [F.Score]: (i * 31) % 1000 } });
console.log(`loading ${RECORDS} records…`);
const t0 = performance.now();
{
  let next = 0;
  const worker = async () => { for (;;) { const s = next; next += 100; if (s >= RECORDS) return; await call('POST', `/api/v1/tables/${tbl.id}/records`, { records: Array.from({ length: Math.min(100, RECORDS - s) }, (_, k) => rec(s + k)) }, TOKEN); } };
  await Promise.all(Array.from({ length: 4 }, worker));
}
const loadSec = (performance.now() - t0) / 1000;
console.log(`loaded in ${loadSec.toFixed(1)}s (${(RECORDS / loadSec).toFixed(0)} records/s via batch API)`);
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL }); await owner.connect();
await owner.query('ANALYZE records');
const sizes = (await owner.query(`SELECT pg_size_pretty(pg_table_size('records')) AS tbl, pg_size_pretty(pg_indexes_size('records')) AS idx`)).rows[0];

// ── load driver ──
interface Scenario { name: string; note: string; req(i: number, w: number): { method: string; url: string; body?: unknown } }
const ids: { id: string }[] = (await call('POST', `/api/v1/tables/${tbl.id}/records/query`, { limit: 500, fields: [F.Name] }, TOKEN)).records;
const pool = ids.map((r) => r.id);
const q = (body: unknown) => ({ method: 'POST', url: `/api/v1/tables/${tbl.id}/records/query`, body });
const proj = [F.Name, F.Status, F.Qty, F.Price, F.Due, F.Done, F.Region, F.Contact];
const scenarios: Scenario[] = [
  { name: 'list-100-default-order', note: 'first page, 100 rows x 8 projected fields, seq order', req: () => q({ limit: 100, fields: proj }) },
  { name: 'list-100-deep-cursor', note: 'page after ~50k rows via cursor (keyset)', req: () => q({ limit: 100, fields: proj, cursor: deepCursor }) },
  { name: 'filter-status-eq', note: 'single select eq (20% of rows), no field index', req: () => q({ limit: 100, fields: proj, filter: { field: F.Status, op: 'eq', value: 'Approved' } }) },
  { name: 'filter-and-or', note: 'AND/OR group on select + integer + checkbox', req: () => q({ limit: 100, fields: proj, filter: { and: [{ field: F.Region, op: 'eq', value: 'East' }, { or: [{ field: F.Qty, op: 'gte', value: 45 }, { field: F.Done, op: 'is_true' }] }] } }) },
  { name: 'filter-rare-score', note: 'Score eq 777 (~0.1% of rows)', req: () => q({ limit: 100, fields: proj, filter: { field: F.Score, op: 'eq', value: 777 } }) },
  { name: 'sort-qty-desc', note: 'sort integer desc, 100 rows', req: () => q({ limit: 100, fields: proj, sort: [{ field: F.Qty, direction: 'desc' }] }) },
  { name: 'sort-name-asc', note: 'sort text asc (unindexed)', req: () => q({ limit: 100, fields: proj, sort: [{ field: F.Name, direction: 'asc' }] }) },
  { name: 'search-trigram', note: "search 'granite vertex' (pg_trgm)", req: () => q({ limit: 100, fields: proj, search: 'granite vertex' }) },
  { name: 'count-total', note: 'filter + include_total (capped count)', req: () => q({ limit: 1, fields: [F.Name], include_total: true, filter: { field: F.Region, op: 'eq', value: 'West' } }) },
  { name: 'get-record', note: 'GET one record', req: (i) => ({ method: 'GET', url: `/api/v1/records/${pool[i % pool.length]}` }) },
  { name: 'write-create', note: 'POST one record', req: (i) => ({ method: 'POST', url: `/api/v1/tables/${tbl.id}/records`, body: rec(900_000 + i) }) },
];
let deepCursor = '';
{ let cur: string | undefined; for (let i = 0; i < 500 && i < RECORDS / 100; i++) { const r = await call('POST', `/api/v1/tables/${tbl.id}/records/query`, { limit: 100, fields: [F.Name], cursor: cur }, TOKEN); if (!r.next_cursor) break; cur = r.next_cursor; deepCursor = cur!; if (i === Math.floor(RECORDS / 200) - 1) break; } }

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
async function drive(s: Scenario, clients: number, seconds: number, extraHeaders: Record<string, string> = {}) {
  const lat: number[] = []; let errors = 0, n = 0; const end = performance.now() + seconds * 1000;
  const run = async (w: number) => {
    while (performance.now() < end) {
      const i = n++; const r = s.req(i, w); const t = performance.now();
      try {
        const res = await fetch(base + r.url, { method: r.method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extraHeaders }, body: r.body === undefined ? undefined : JSON.stringify(r.body) });
        await res.arrayBuffer();
        if (!res.ok) errors++;
      } catch { errors++; }
      lat.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: clients }, (_, w) => run(w)));
  return { name: s.name, note: s.note, requests: lat.length, errors, rps: +(lat.length / seconds).toFixed(1), p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2), max: +Math.max(...lat).toFixed(2), raw: lat.map((x) => +x.toFixed(2)) };
}

const peak = { api: 0 }; const sampler = setInterval(() => { peak.api = Math.max(peak.api, rssKb(srv.pid!)); }, 250);
const idleRss = rssKb(srv.pid!);
const results: any[] = [];
for (const s of scenarios) { await drive(s, 4, 1); const r = await drive(s, CLIENTS, SECONDS); results.push(r); console.log(`${r.name.padEnd(26)} rps=${String(r.rps).padStart(7)} p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms err=${r.errors}`); }

// record-update scenario: each record is patched exactly once at version 1 (no conflicts), 20 clients
{
  const all: string[] = []; let cur: string | undefined;
  while (all.length < 6000) { const r = await call('POST', `/api/v1/tables/${tbl.id}/records/query`, { limit: 500, fields: [F.Name], cursor: cur }, TOKEN); all.push(...r.records.map((x: any) => x.id)); cur = r.next_cursor; if (!cur) break; }
  const upd: Scenario = { name: 'write-update', note: 'PATCH one record (If-Match version 1)', req: (i) => ({ method: 'PATCH', url: `/api/v1/records/${all[i % all.length]}`, body: { fields: { [F.Qty]: i % 50 } } }) };
  const lat: number[] = []; let errors = 0, n = 0; const end = performance.now() + Math.min(SECONDS, (all.length / 1500));
  await Promise.all(Array.from({ length: CLIENTS }, async () => { while (performance.now() < end && n < all.length) { const i = n++; const r = upd.req(i, 0); const t = performance.now(); const res = await fetch(base + r.url, { method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify(r.body) }); await res.arrayBuffer(); if (!res.ok) errors++; lat.push(performance.now() - t); } }));
  const r = { name: upd.name, note: upd.note, requests: lat.length, errors, rps: +(lat.length / Math.max(1, Math.min(SECONDS, all.length / 1500))).toFixed(1), p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2), max: +Math.max(...lat).toFixed(2), raw: lat.map((x) => +x.toFixed(2)) };
  results.push(r); console.log(`${r.name.padEnd(26)} rps=${String(r.rps).padStart(7)} p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms err=${r.errors}`);
}

// ── field index experiment: same queries before/after ──
const idxResults: any[] = [];
for (const [fname, fid, sc] of [['Score', F.Score, scenarios.find((s) => s.name === 'filter-rare-score')!], ['Qty', F.Qty, scenarios.find((s) => s.name === 'sort-qty-desc')!], ['Name', F.Name, scenarios.find((s) => s.name === 'sort-name-asc')!], ['Status', F.Status, scenarios.find((s) => s.name === 'filter-status-eq')!]] as const) {
  const before = results.find((r) => r.name === sc.name)!;
  const ti = performance.now();
  await call('PATCH', `/api/v1/fields/${fid}`, { indexed: true });
  const buildSec = (performance.now() - ti) / 1000;
  await owner.query('ANALYZE records');
  const after = await drive({ ...sc, name: sc.name + '+index' }, CLIENTS, SECONDS);
  const sz = (await owner.query(`SELECT pg_size_pretty(pg_indexes_size('records')) s`)).rows[0].s;
  idxResults.push({ field: fname, scenario: sc.name, buildSeconds: +buildSec.toFixed(1), indexesSizeAfter: sz, before: { p50: before.p50, p95: before.p95, rps: before.rps }, after: { p50: after.p50, p95: after.p95, rps: after.rps }, raw: after.raw });
  console.log(`index ${fname}: ${sc.name} p95 ${before.p95}ms -> ${after.p95}ms (build ${buildSec.toFixed(1)}s, indexes ${sz})`);
}
clearInterval(sampler);

// ── EXPLAIN ANALYZE of representative compiled queries (as the app role, with RLS context) ──
const { compileQuery } = await import('../src/query.js');
const fields = tbl.fields as any[];
const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL }); await app.connect();
const plans: string[] = [];
for (const [label, query] of [
  ['list default', { limit: 100, fields: proj }], ['filter status eq (indexed)', { limit: 100, filter: { field: F.Status, op: 'eq', value: 'Approved' } }],
  ['filter score eq (indexed)', { limit: 100, filter: { field: F.Score, op: 'eq', value: 777 } }], ['sort qty desc (indexed)', { limit: 100, sort: [{ field: F.Qty, direction: 'desc' }] }],
  ['sort name asc (indexed)', { limit: 100, sort: [{ field: F.Name, direction: 'asc' }] }], ['search trigram', { limit: 100, search: 'granite vertex' }], ['multi-select has_any', { limit: 100, filter: { field: F.Tags, op: 'has_any', value: ['Rush'] } }],
] as [string, any][]) {
  const c = compileQuery(tbl.id, fields, query, 'x'.repeat(48));
  await app.query('BEGIN'); await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
  const ex = await app.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${c.sql}`, c.params);
  await app.query('ROLLBACK');
  plans.push(`### ${label}\n${ex.rows.map((r: any) => r['QUERY PLAN']).join('\n')}\n`);
}
const mem = { api_idle_rss_mb: +(idleRss / 1024).toFixed(1), api_peak_rss_mb: +(peak.api / 1024).toFixed(1), api_hwm_mb: +(hwmKb(srv.pid!) / 1024).toFixed(1), postgres_total_rss_mb: pgRssMb() };
const meta = {
  when: new Date().toISOString(), records: RECORDS, fields: 20, clients: CLIENTS, secondsPerScenario: SECONDS, loadSeconds: +loadSec.toFixed(1), tableSize: sizes.tbl, indexesSizeBeforeFieldIndexes: sizes.idx,
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()}`, node: process.version, postgres: (await owner.query('SHOW server_version')).rows[0].server_version },
  note: 'Load generator, API and PostgreSQL share ONE machine (no network latency). Numbers are API-level, warm cache. See PERFORMANCE.md for limitations.',
};
writeFileSync(resolve(rawDir, 'results.json'), JSON.stringify({ meta, memory: mem, results: results.map(({ raw, ...r }) => r), indexExperiments: idxResults.map(({ raw, ...r }) => r) }, null, 2));
writeFileSync(resolve(rawDir, 'latencies.json'), JSON.stringify({ results: Object.fromEntries(results.map((r) => [r.name, r.raw])), indexed: Object.fromEntries(idxResults.map((r) => [r.scenario + '+index', r.raw])) }));
writeFileSync(resolve(rawDir, 'explain.txt'), plans.join('\n'));
console.log(JSON.stringify({ meta, mem }, null, 2));
await owner.end(); await app.end(); srv.kill('SIGTERM');
