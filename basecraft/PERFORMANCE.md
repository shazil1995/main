# Basecraft performance report

Every number here comes from raw output kept in `bench/` and can be reproduced (commands at the bottom). Targets from the brief are
**targets to validate, not claims**; where a target was missed it is stated as missed.

## Test profile (read this first)

| | |
|---|---|
| Host | 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 15.7 GB RAM, Linux 6.18.44-fc-v70 — **not** the 2 vCPU / 4 GB sizing target |
| Software | Node v22.22.0, PostgreSQL 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1), Fastify 5, `pg` pool of 10, API in a separate process (built `dist/`) |
| Network | load generator, API and Postgres on **one machine**, loopback only: no WAN latency, and the three compete for the same 4 cores |
| Dataset | one table, **100,000 records x 20 mixed fields** (+ ~6,000 created by the write scenarios): table heap 130 MB, `records` indexes 43 MB before any per-field index; loaded through the public batch API in 14.1 s |
| Load | 20 concurrent keep-alive clients, 10 s per scenario after a 1 s warm-up, token auth, **warm cache**, 8 projected fields / 100 rows per list call |
| Measurement | every request latency recorded (`bench/raw/latencies.json`); percentiles are exact, not histogram buckets |
| DB provisioning | superuser LEAKPROOF fast paths **installed** (`leakproofFastPathsProvisioned: true`); see "RLS and indexes" below |

Not tested: the 2 vCPU/4 GB profile, a remote database, more than one API instance, datasets beyond 100k records, wide/sparse schema
fixtures (only the 20-field table), cold cache, or long soak/leak runs.

## Results at 100k records, 20 concurrent clients

| scenario | what | req/s | p50 ms | p95 ms | p99 ms | errors |
|---|---|--:|--:|--:|--:|--:|
| `list-100-default-order` | first page, 100 rows x 8 projected fields, seq order | 343.2 | 55.97 | 89.9 | 114.64 | 0 |
| `list-100-deep-cursor` | page after ~50k rows via cursor (keyset) | 397.1 | 49.31 | 68.67 | 82.02 | 0 |
| `filter-status-eq` | single select eq (20% of rows), no field index | 375.2 | 53.05 | 70.81 | 78.85 | 0 |
| `filter-and-or` | AND/OR group on select + integer + checkbox | 26.1 | 785.73 | 1078.8 | 1152.24 | 0 |
| `filter-rare-score` | Score eq 777 (~0.1% of rows) | 52.8 | 381.17 | 491.67 | 564.09 | 0 |
| `sort-qty-desc` | sort integer desc, 100 rows | 8.6 | 2563.54 | 4037.38 | 4465.44 | 0 |
| `sort-name-asc` | sort text asc (unindexed) | 8.3 | 2597.19 | 4192.51 | 4533.66 | 0 |
| `search-trigram` | search 'sign 7777' (substring; matches ~11 rows) | 413.9 | 47.37 | 67.32 | 78.98 | 0 |
| `count-total` | filter + include_total (capped count) | 45.9 | 441 | 564.52 | 627.06 | 0 |
| `get-record` | GET one record | 744.7 | 25.84 | 39.62 | 50.15 | 0 |
| `write-create` | POST one record | 564.9 | 34.69 | 50.18 | 60.5 | 0 |
| `write-update` | PATCH one record (If-Match version 1), 6000 distinct records | 679.5 | 28.23 | 45.45 | 55.75 | 0 |

Raw: `bench/raw/results.json`, `bench/raw/latencies.json`. A p95 under load is dominated by queueing: with 20 clients on 4 cores shared
with Postgres, latency ≈ 20 / throughput. A single query on an idle machine is much faster (see EXPLAIN section).

### Against the brief's targets

| target | measured | verdict |
|---|---|---|
| warm **indexed** list/filter p95 <= 250 ms, 100 projected rows | list 89.9 ms; deep-cursor page 68.7 ms; indexed filter 66.6-71.2 ms; indexed sort 70.5-75.0 ms; substring search 67.3 ms | **met** on this host (with the caveat that load generator and DB share it) |
| simple record write p95 <= 300 ms | create 50.2 ms; update 45.5 ms (both with audit row + version check in one transaction) | **met** |
| API RSS <= 300 MB steady-state | idle 209.1 MB, peak under load 214.3 MB (HWM 216.5 MB) incl. the inline worker | **met** |
| worker RSS <= 200 MB | worker ran inline in the API process (included above); not measured separately | **not measured** |
| initial compressed JS <= 250 KB | core route ~ 120 KB gzipped (vendor 87 + app 8 + table page 17 + format 2 + css 4); everything else lazy | **met** (see Bundles) |
| browser memory bounded for 100k rows | JS heap ~5 MB, 28-36 rendered rows, 750-934 DOM nodes, 800 cached rows regardless of scroll depth | **met** |
| **un-indexed** filters/sorts | see below: slow | **missed** — reported separately as the brief allows |

## Where it is slow (and what to do)

* **Un-indexed sort over 100k rows: p95 ~4 s** at 20 concurrent clients (Postgres extracts the JSON key from every one of the 100k rows and top-N sorts them; per-query CPU was not separately captured). With a field index: **~71 ms** (57x better p95, 45x throughput). Index fields you sort by.
* **Un-indexed rare-value filter: p95 ~490 ms** (full scan). With the field index: **71 ms**.
* **Un-indexed multi-condition filter (`filter-and-or`): p95 ~1.08 s** under load; ~50 ms per query on an idle machine in an ad-hoc `EXPLAIN ANALYZE` (parallel seq scan; that plan was not saved to `bench/raw/`). In the first run the planner happened to choose an ordered-index plan for the same query (p95 78 ms): Postgres has **no statistics for un-indexed JSONB expressions**, so it guesses selectivity and the choice is unstable. Creating a field index also creates expression statistics, which stabilises estimates for that field. Treat "filters on un-indexed fields" as ~50 ms CPU each, saturating around 25 queries/s on this host.
* **`include_total` counts**: p95 ~565 ms under load (it counts up to 100,001 matching rows). The count is O(matching rows); the UI requests it with the first page only. Making it lazy/approximate is a known follow-up.
* **Audit volume**: every record write writes an audit row (100,000 imported records produced ~106,000 audit rows, 16 MB dump total). Bulk imports use summary rows; the batch API does not. Budget storage for this or tune `AUDIT_RETENTION_DAYS`.

### Index experiments (same load, before vs after enabling the per-field index)

| experiment | before p95 ms | after p95 ms | before req/s | after req/s | build s | all `records` indexes after |
|---|--:|--:|--:|--:|--:|--:|
| `filter-rare-score` (index on Score) | 491.67 | 71.15 | 52.8 | 386.5 | 0.4 | 52 MB |
| `sort-qty-desc` (index on Qty) | 4037.38 | 70.54 | 8.6 | 380.1 | 0.4 | 59 MB |
| `sort-name-asc` (index on Name) | 4192.51 | 75.01 | 8.3 | 354.7 | 0.5 | 64 MB |
| `filter-status-eq` (index on Status) | 70.81 | 66.62 | 375.2 | 397.3 | 0.2 | 68 MB |

Cost of those four field indexes: `records` index size 43 MB -> 68 MB (+25 MB for six indexes — text for all four fields plus numeric-cast indexes for Qty and Score — about +14 % of the 173 MB heap+indexes on this data). Write throughput with the indexes in place was not re-measured (create/update were measured **before** the index experiments) — **write amplification from field indexes is unmeasured**.

## RLS and indexes (an issue found by this benchmark)

The first benchmark run showed the field index helping sorts (4.9 s -> 77 ms) but **not filters** (rare filter 741 ms -> 827 ms), and the
trigram search index was never used. Cause (confirmed with `EXPLAIN`): behind a row-level-security policy Postgres only pushes an
operator into an index condition if it is LEAKPROOF; jsonb `->>`, numeric casts and `LIKE` are not. Same query as the table owner
(no RLS): 0.7 ms and index scan; as the RLS-enforced app role: 137 ms and a scan of 101,077 rows.

Fix: two superuser-provisioned aliases of stock functions marked LEAKPROOF (`bc_jtext`, and a `~~~` LIKE operator with its own GIN
operator class), documented in `docs/architecture.md` and `SECURITY.md`, with a plain fallback when no superuser is available.

| scenario | before fast paths p95 ms (run 1) | after p95 ms (run 2) |
|---|--:|--:|
| `search-trigram` | 783.5 (different term: 0 matches) | 67.3 (`sign 7777`, 11 matches) — single-query plan 48 ms seq scan -> 4 ms bitmap index scan |
| `filter-rare-score` un-indexed | 741.4 | 491.7 (run-to-run noise on the same plan) |
| `filter-rare-score` with field index | 827.1 (index **unusable** behind RLS) | 71.2 |
| `sort-qty-desc` with field index | 76.9 | 70.5 |
| `filter-and-or` | 78.5 (planner picked an ordered scan) | 1078.8 (planner picked a parallel seq scan) |
| `write-update` | 30.6 — **invalid**: a unit bug sent only ~20 requests | 45.5 over 6,000 requests |

Raw "before" output is preserved in `bench/before-fast-paths/`. Both runs are single executions: variance between runs was not measured,
so differences under ~20 % should not be read as real.

Without the superuser step all functionality is identical (all 116 server tests pass on a database with no provisioning) but filters and
search at this scale behave like the "before" rows.

## EXPLAIN ANALYZE (idle machine, as the RLS-enforced app role)

Full plans: `bench/raw/explain.txt`. Highlights at 100k rows:

| query | plan | execution |
|---|---|--:|
| default list (100 rows) | index scan `records_table_seq_idx`, stops after 101 rows | 0.6 ms |
| filter status = X (indexed) | index scan on field text index, `Index Cond: bc_jtext(...) = ...` | 0.4 ms |
| filter score = 777 (indexed) | same | 0.5 ms |
| sort qty desc (indexed) | `Index Scan Backward` on the numeric index, no sort node | 0.3 ms |
| sort name asc (indexed) | index scan, no sort node | 0.3 ms |
| search 'sign 7777' | bitmap index scan on `records_search_idx` (trigram) | 4.3 ms |

## Memory

* **API process**: idle 209.1 MB, peak 214.3 MB during all scenarios (sampled every 250 ms from `/proc/<pid>/status`), HWM 216.5 MB.
* **PostgreSQL**: sum of per-process RSS was 2158 MB, which **over-counts** (shared buffers are counted once per backend) and includes the
  load generator's connections; it is an upper bound, not a sizing figure. Postgres memory for the 4 GB profile was not measured (`shared_buffers` was the Ubuntu default).
* **Browser** (`bench/raw/browser-memory.json`, Chromium 141, headless): after forced GC, JS heap 3.7 MB initially and 5.1-5.6 MB after 60 scroll-to-bottom steps
  (~6,000+ rows streamed through) and after scrolling back up; grid holds at most 8 pages x 100 = 800 rows; 28-36 `role=row` elements and <= 934 DOM nodes at any time.
  Walking back to the first record took 54 upward scroll steps via `prev_cursor`. This measures JS heap only, not total browser process memory.
* Build tooling (tsc/vite) memory was not measured.

## Bundles

`vite build` output (gzip): vendor (React, Query, Virtual) 87.0 KB, app entry 8.1 KB, table page 17.2 KB, shared format 2.4 KB, filter builder 3.2 KB, CSS 3.8 KB
=> **~122 KB** for the core workspace route. Lazy chunks: automations 6.6 KB, settings 6.3 KB, calendar 4.2 KB, kanban 2.2 KB, gallery 1.6 KB, form 2.4 KB.

## Other measurements

* Bulk load via batch API: 4,900 -> 7,100 records/s (two runs; 100 records per request, 4 clients). Import job path was not benchmarked.
* Backup/restore of the 106k-record database: `pg_dump -Fc` 16 MB in 2.0 s, `pg_restore` 7.1 s (`bench/raw/restore-test.txt`).

## Reproduce

```bash
# fresh database with fast paths (needs a superuser once)
su postgres -c "createdb -O basecraft_owner basecraft_bench"
su postgres -c "psql -d basecraft_bench -c 'create extension pg_trgm' -f server/sql/leakproof.sql"
export DATABASE_URL=postgres://basecraft_owner:…@localhost/basecraft_bench APP_DATABASE_URL=postgres://basecraft_app:…@localhost/basecraft_bench
npm run db:migrate && npm run build -w server
npx tsx server/scripts/bench.ts --records 100000 --clients 20 --seconds 10     # raw output -> bench/raw/
BASE=http://localhost:4101 BENCH_EMAIL=… BENCH_PASSWORD=… node web/e2e/memory.mjs   # browser memory (server on the bench DB, port 4101)
```

## Known follow-ups (not done)

Measure on the 2 vCPU/4 GB profile with a remote DB; wide (200-field) and sparse fixtures; write cost with many field indexes; cold-cache runs;
a soak test with RSS tracking; lazy/approximate totals; planner-stable plans for un-indexed multi-condition filters (e.g. per-table extended statistics or
index advice in the UI); import-job throughput; connection-pool saturation tests.
