# Basecraft architecture (Phase 1)

## Decision record: where this lives and why

The repository already contained an unrelated project (the Signage CRM: NestJS + Prisma, with its own `CLAUDE.md` whose
spec takes precedence for that project). The Basecraft brief says to preserve existing work and choose the smallest
extension consistent with the goal, so Basecraft is built as an **isolated npm-workspaces project in `basecraft/`** with no
changes to the CRM. Nothing is shared at runtime. If you want Basecraft in its own repository, `git subtree split -P basecraft`
produces a clean history. The CRM's NestJS/Prisma stack was **not** reused: the brief asks for Fastify, parameterised SQL and no
ORM hydration of large records.

## Shape: a modular monolith

```
web (React 19 + Vite + TanStack Query/Virtual) ──HTTP/JSON──▶ server (Fastify 5, TypeScript, zod)
                                                              │  routes/*  thin handlers
                                                              │  records.ts / query.ts / fieldTypes.ts   domain
                                                              │  worker.ts  (in-process or `npm run worker`)
                                                              ▼
                                                     PostgreSQL 16 (+ pg_trgm)      local disk (S3 port) for blobs
```

* One API process, one database, an **optional** worker (`WORKER_MODE=inline|separate|off`). No Redis, queue broker, search
  engine or ORM. Jobs are rows in Postgres claimed with `FOR UPDATE SKIP LOCKED`.
* `shared/` holds dependency-free definitions used by both sides (field types, operator tables, the role/permission matrix).
  The server is always authoritative; the UI only uses them to hide controls.

## Data model

Relational metadata (`users, sessions, workspaces, members, invitations, api_tokens, bases, tables, fields, views, automations,
resource_grants, attachments, comments, import_jobs, outbox_events, automation_runs, audit_events, idempotency_keys`) plus one
`records` table whose cell values live in **bounded JSONB keyed by stable field UUID** (`pg_column_size("values") <= 1 MiB`,
application cap 256 KiB).

Why JSONB (and what it costs):

| option | verdict |
|---|---|
| JSONB per record (**chosen**) | Schema changes (add/rename/hide field) are metadata-only; one row per record; GIN not needed because we index selectively. Cost: values are untyped to Postgres, so casts (`::numeric`) are done in queries, and per-field statistics are weaker than real columns. |
| Typed cell table (EAV) | Strong typing and per-type indexes, but N rows per record and heavy joins to materialise a page. Rejected for read-heavy grids. |
| Physical column per field (DDL on user action) | Fastest scans, but DDL locks, 1600-column limit, and migrations on every schema edit. Rejected for Phase 1. |

Typed projection strategy: a field may be flagged `indexed`; the server then runs (CONCURRENTLY, as the owner role, after commit)
`CREATE INDEX … ON records ((bc_jtext("values",'<field-uuid>')), seq) WHERE table_id = '<uuid>'` — a partial, per-table expression index —
and, for numeric types, a second `((bc_jtext(…))::numeric, seq)` index for numeric ORDER BY. Both sort directions use one index because
ASC is `NULLS LAST` and DESC is `NULLS FIRST` (Postgres defaults) and the `seq` tie-break follows the first sort direction. Indexes are
opt-in because each one adds write amplification and disk (measured in `PERFORMANCE.md`).

### The row-level-security / index interaction (important, measured)

Behind an RLS policy Postgres only pushes an operator into an *index condition* if the operator is **LEAKPROOF**. jsonb `->>`, numeric
casts/comparisons and `LIKE` are not, so with plain SQL every JSONB filter and every search silently became a table scan (measured on
100k rows: a rare-value filter 137 ms vs 0.6 ms; ORDER BY was unaffected because ordering is not a qual). Basecraft therefore queries
through two aliases of stock Postgres functions — `bc_jtext` (= `jsonb_object_field_text`) and the `~~~` operator (= `textlike`, with its
own GIN operator class `bc_trgm_ops`) — which a **superuser** marks LEAKPROOF once per database (`server/sql/leakproof.sql`, run by
`db-init.sh`). Without that step migration 0004 installs equivalent plain functions: results are identical, queries are just slower at
scale (the full test suite passes both ways; the server logs a warning at startup). What this does and does not buy:

| predicate | index-assisted behind RLS when provisioned |
|---|---|
| equality / IN on text, email, URL, phone, selects, dates, datetimes, checkbox, and equality on numbers (canonical text form) | yes |
| range (`>`, `<`) on text/date/datetime (fixed-width text) | yes |
| range on integer/decimal/currency/percent (numeric operators are not leakproof) | **no** (scan) |
| `contains` / `starts_with` / `not_contains` (ILIKE) | **no** (scan); the `search` box uses the trigram path instead |
| multi-select `has_*` (jsonb `?|`) | **no** (scan) |
| ORDER BY on an indexed field (either direction) | yes |

Value representation (all validated in `server/src/fieldTypes.ts`):
`integer` → JSON number (safe-int range); `decimal/currency/percent` → canonical **string** with fixed scale (never a float;
excess precision is rejected, not rounded); `date` → `YYYY-MM-DD`; `datetime` → UTC instant `…Z` with fixed width (so text
order is time order); naive local times are accepted only for fields with a time zone and are rejected when they fall in a DST
gap or are ambiguous; `checkbox` → `true|false` (absent = empty, distinct from `false`); selects store option ids; `0`, `false`
and `""`/`null`/`[]` are different things (`""` and `[]` normalise to empty).

## Tenant isolation (three layers)

1. **Application authz**: every route declares `scope: {resource, permission}`; the framework resolves the resource to its
   workspace (`bc_resolve`), opens a transaction, loads the principal's role (+ base/table grants), and answers `404` when the
   principal has no visibility and `403` when it lacks the permission. Unknown ids and other tenants' ids look identical.
2. **Row-level security**: content tables carry `workspace_id` with `FORCE`-less RLS policies keyed on
   `current_setting('app.workspace_id')`, set per transaction with `set_config(..., true)` (cannot leak across pooled
   connections — tested). The application connects as `basecraft_app` (non-owner, `NOBYPASSRLS`). The owner role is used only
   for migrations/tests.
3. **Composite foreign keys** `(id, workspace_id)` so even a privileged writer cannot attach a record to another tenant's table.

The only cross-tenant reads available to the app role are a handful of `SECURITY DEFINER` functions with fixed bodies:
`bc_resolve` (ids only), `bc_claim_outbox`, `bc_claim_import_job`, `bc_cleanup`, `bc_orphan_attachments`, `bc_purge_attachment_row`.
Tables not under RLS (`users, sessions, workspaces, members, invitations, api_tokens`) are only queried with explicit filters
on the authenticated principal.

## Request pipeline (`server/src/http.ts`)

authenticate (session cookie or `Bearer bc_…`) → rate limit (per user/token, per workspace, per IP when anonymous) → Origin and
CSRF check for state-changing browser requests → params → resolve resource → `BEGIN` + RLS context → authorize → parse
query/body (strict zod; unknown keys rejected, so forged `workspace_id`/`created_by` fail) → idempotency wrapper (same
transaction) → handler → `COMMIT` → post-commit hooks (e.g. `CREATE INDEX CONCURRENTLY`). Errors use one envelope
`{error:{code,message,details?,trace_id}}`; `x-request-id` is honoured/generated and echoed.

## Writes: one pipeline for UI, API, forms, imports and automations

`records.ts` (`createRecords/updateRecord/deleteRecord`) validates every field, enforces `If-Match`/version (412), writes the
row, an **audit event** and — when the table has enabled automations — an **outbox event**, all in the caller's transaction.
No-op updates do not bump the version or emit events. Bulk imports write one summary audit row per batch.

## Automations and jobs (`worker.ts`, `automations.ts`)

* Claim with leases (`bc_claim_outbox`, default 60 s); a crashed worker's leases simply expire.
* One transaction per (automation, event): either all actions and the success run row commit, or none do. A unique index on
  `(automation_id, event_id)` for successful/skipped runs makes redelivery idempotent (effectively-once for internal writes).
* Failure → run row `failed`, event back to `pending` with exponential backoff + jitter; after `AUTOMATION_MAX_ATTEMPTS` →
  `dead` plus an audit entry. Loop control: `visited_automations` per chain (an automation runs at most once per chain) and
  `AUTOMATION_MAX_DEPTH`.
* Run history stores ids and field ids only — never record values.
* Imports are jobs too (`import_jobs`): whole-file validation pass, then batches of `IMPORT_BATCH_ROWS` committed atomically with
  their counters and checkpoint; `resume` continues from the checkpoint.
* No outgoing HTTP/email actions exist. They need a secret store, an approval flow and SSRF-safe egress (Phase 3).

## Attachments

Blob bytes never enter the database or record JSON. `BlobStore` is a port; `LocalStore` writes `<workspace>/<uuid>` with
`0600`. Uploads stream with a hard size cap, the **detected** type (magic bytes + extension agreement) is stored, active content
(HTML/SVG/XML/scripts/executables) is rejected, downloads are always `Content-Disposition: attachment`, `nosniff`,
`CSP: sandbox`. Workspace quota is enforced under an advisory lock. Deleted/orphaned rows are purged (blob first) by the
maintenance job after a grace period. A `Scanner` port exists; the default accepts everything that passed the type policy.

## Frontend

`TablePage` owns the view/draft-config state; each view receives `ViewProps` and loads records only through `useRecords`
(server-side search/filter/sort, cursor pagination, **bounded to 8 cached pages** with `prev_cursor` to refetch dropped pages).
The grid virtualizes rows and columns, tracks the active cell by (record id, field id) so focus survives refetches, and anchors
scroll position when pages are dropped or prepended. Heavy screens (settings, automations, each non-grid view) are lazy chunks.

## What is deliberately not here

Linked records/formulas/rollups, row/field-level policies, realtime collaboration, public forms, outgoing HTTP/email actions,
SSO/MFA, CRM connectors, Airtable import. They are tracked in `FEATURE_PARITY.md` with their phase.
