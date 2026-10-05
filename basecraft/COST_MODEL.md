# Basecraft cost model

**Prices are deliberately NOT included.** The build sandbox cannot reach provider price pages, so every `price_*` below is an
input you must fill in from your provider's current price list (state source, date, region, currency). Totals computed from
made-up prices would look authoritative and be wrong. What *is* provided: the sizing formulas, three explicit workload cases,
the measured Basecraft resource figures (from `PERFORMANCE.md`, marked *measured*) and the guardrails that cap spend.

Legend: **(M)** measured in this repo, **(E)** estimated from the formulas, **(A)** assumption you should replace.

## 1. Inputs

| input | symbol | personal pilot (A) | small team (A) | growing team (A) |
|---|---|---|---|---|
| active users | U | 2 | 15 | 80 |
| records (all tables) | R | 20,000 | 500,000 | 5,000,000 |
| avg stored bytes / record (JSONB, 20 mixed fields) | b_r | 700 (M, `PERFORMANCE.md`) | 700 | 1,500 (wider schemas) |
| attachments stored | A_gb | 2 GB | 50 GB | 600 GB |
| API requests / day | q_d | 5,000 | 150,000 | 2,500,000 |
| automation runs / day | a_d | 100 | 5,000 | 100,000 |
| CSV exports / month × avg size | x | 2 × 5 MB | 20 × 50 MB | 200 × 400 MB |
| log retention | d_log | 14 d | 30 d | 30 d |
| availability target | | best effort | 99.5 % (single host + restores) | 99.9 % (needs HA DB — **not provided by this build**) |

## 2. Formulas

```
db_data_gb      = R × b_r / 1e9                          (table heap)
db_index_gb     = db_data_gb × k_idx                     (k_idx ≈ measured index/heap ratio, see PERFORMANCE.md; grows with each `indexed` field)
db_total_gb     = (db_data_gb + db_index_gb) × 1.3       (30 % headroom for bloat/WAL)
backup_gb       = db_total_gb × n_retained_dumps × 0.25  (custom-format dumps compress ≈ 4:1 on this data — measure yours)
blob_gb         = A_gb × (1 + n_versions_kept × 0)       (no versioning in Phase 1)
blob_backup_gb  = blob_gb × copies
egress_gb/month = exports + downloads + (q_d × 30 × avg_response_kb / 1e6)
requests/month  = q_d × 30                               (object-store GET/PUT counts ≈ attachment ops only)
compute         = pick the smallest instance whose RAM ≥ api_rss + worker_rss + postgres_shared_buffers + os, with ≥ 2 vCPU

monthly_cost = price_compute × instances
             + price_db_gb × db_total_gb  (or managed-DB price tier)
             + price_obj_gb × (blob_gb + blob_backup_gb) + price_obj_req × requests
             + price_egress_gb × egress_gb
             + price_backup_gb × backup_gb
             + price_monitoring × (hosts or GB of logs)
             + price_email × messages            (Phase 1 sends none; $0)
             + price_ai × tokens                 (AI is not implemented and off by design; $0)
             + ops_hours × hourly_rate           (patching, restore drills, on-call — usually the dominant cost)
```

## 3. What the three cases imply (E, using formulas + measured sizes)

| | personal pilot | small team | growing team |
|---|---|---|---|
| db_data (R × b_r) | ≈ 14 MB | ≈ 350 MB | ≈ 7.5 GB |
| db_total with indexes + 30 % | well under 1 GB | ≈ 1–2 GB | ≈ 15–25 GB |
| fits the 2 vCPU / 4 GB profile? | yes | yes (measured budget below) | **unproven** — only 100k records were load-tested; plan a re-measure at 5M and likely a managed Postgres |
| attachments | 2 GB local disk | needs object storage (S3 adapter **not built yet**) | object storage + scanner required |
| availability | single host | single host + tested restores (RPO = backup interval, RTO ≈ restore time, see BACKUP_RESTORE.md) | needs replicas/failover: out of scope for Phase 1 |

Measured Basecraft footprint at 100k records / 20 clients is reported in `PERFORMANCE.md` (API RSS, Postgres RSS, p95s). Treat
anything beyond that dataset as extrapolation.

## 4. Cost drivers you control

* **Indexes**: each `indexed` field adds disk and write cost (measured in `PERFORMANCE.md`). Index only fields that are filtered/sorted often.
* **Polling vs events**: Phase 1 has no external polling. When connectors arrive prefer provider webhooks over polling (planned).
* **Worker concurrency** (`WORKER_CONCURRENCY`, default 2) and `DB_POOL_MAX` (default 10) bound CPU/connection use.
* **Log retention**: the server logs summaries (no bodies); keep `d_log` short. Audit retention is `AUDIT_RETENTION_DAYS` (default 365) and outbox `OUTBOX_RETENTION_DAYS` (7).
* **Egress**: full exports stream; cap with `MAX_EXPORT_ROWS`.

## 5. Guardrails that exist today vs. before public launch

| guardrail | status |
|---|---|
| per-token / per-workspace / per-IP rate limits | **exists** (in-memory) |
| per-file size and per-workspace attachment quota | **exists** |
| max import rows/bytes, max export rows, statement timeout, body limit | **exists** |
| automation depth/attempt caps; no outbound calls | **exists** |
| per-workspace record quota, spend alerts, per-workspace automation budget | **missing — add before public access** |
| budget alerts / billing integration | **missing** (provider-side configuration) |

## 6. Operations that cost money even when idle (don't forget)

Restore drills (a backup is not valid until restored — `server/scripts/restore-test.sh`), dependency updates, certificate
renewal, monitoring/alerting setup, and someone being reachable. Budget hours, not just infrastructure.
