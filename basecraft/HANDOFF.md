# HANDOFF (updated 2026-10-05)

## State

Phase 1 of the Basecraft brief is implemented in `basecraft/` and verified as described below. It is **not** "production ready"; see
`FEATURE_PARITY.md` for every capability's status and `SECURITY.md` / `PERFORMANCE.md` for limits. Everything is committed on
`claude/hopeful-hopper-z0xsen` (no PR was opened). The Signage CRM elsewhere in the repo was not touched.

## What was verified (and how to re-run)

| check | result | command |
|---|---|---|
| server unit + integration tests (real Postgres) | **116 passed** | `npm test -w server` (needs `basecraft_test` + roles; see below) |
| same suite on a DB **without** superuser provisioning (fallback path) | 116 passed | `TEST_DATABASE_URL=…/basecraft_nolp npx vitest run` |
| web unit tests | passed (pure logic only: grid nav, formats, CSV, calendar math, admin logic) | `npm test -w web` |
| typecheck + production build | clean | `npm run build` |
| Chromium end-to-end (login → grid edit/undo → views → form → settings → mobile) | **26/26** | `DEMO_PASSWORD=… npm run e2e -w web` (server running, `db:seed` data) |
| API client examples (TS, Python, CRM upsert) against the live API | ran OK (idempotent replay, 412, paging, upserts) | `docs/examples/` |
| backup → restore into a clean DB at 106k records | verified | `server/scripts/restore-test.sh` |
| load test 100k records / 20 clients | see `PERFORMANCE.md` (met indexed targets, **missed** un-indexed ones) | `server/scripts/bench.ts` |
| browser memory over 100k rows | flat ~5 MB heap, 800 cached rows | `web/e2e/memory.mjs` |

## Phase-1 completion rule, checked

A new user can start the app, sign up, create a base/table/fields, add and edit validated records, reload and see durable data, save and switch
views, run an automation (record created/updated/condition/form → update/create record), and call the API with a hashed scoped token; unauthorised
requests fail (tests: `security.test`). Included from the chosen scope: CSV import, forms, attachments, roles, invitations, audit, tokens, OpenAPI,
examples. **Partial** items are listed in `FEATURE_PARITY.md` (notably: no field type change, no outgoing HTTP/email automation actions, no MFA, grid has no
multi-cell range selection, no S3 adapter/malware scanner, no WAL/PITR).

## Environment you need to resume

* Node >= 22, PostgreSQL 16 with `pg_trgm`. Roles `basecraft_owner` (migrations/tests) and `basecraft_app` (requests, `NOBYPASSRLS`). Local dev used passwords from `server/.env` (gitignored; template `.env.example`).
* Databases created locally: `basecraft` (dev + seeded demo), `basecraft_test`, `basecraft_bench`. `su postgres` was used for provisioning in the sandbox; `postgres` role password was set to a dev value there.
* Optional fast paths: run `server/sql/leakproof.sql` as superuser on each DB **before** `npm run db:migrate` (`db-init.sh` does it). Without it everything works, slower at scale.
* Migration state: `0001_init`, `0002_resolve`, `0003_runs_index`, `0004_fast_paths` applied on all three local DBs. Applied migrations are checksummed; never edit them.
* The demo seed password is printed once by `npm run db:seed`; it was only used locally.

## Known problems / things I would not trust yet

1. **Docker**: `Dockerfile`/`docker-compose.yml` were written but never built (no Docker daemon in the sandbox). The compose `init` entrypoint in particular is untested.
2. **Un-indexed filters/sorts are slow at 100k rows** (sort ~4 s p95 under 20 clients; multi-condition filter ~1 s). Index the fields; see PERFORMANCE.md. Planner plans for un-indexed JSONB filters are unstable (no statistics).
3. Write amplification of field indexes and the `bc_trgm_ops` search index was **not measured**.
4. The Airtable support docs, HubSpot and Salesforce docs were unreachable from the sandbox (egress blocked): parity statuses are `unverified-reference`; no connector work was started.
5. Kanban/gallery/calendar/form/import/export/settings/automation UIs were built by delegated workers; they pass type-checking, unit tests of their pure logic and the Chromium run (which opens each), but have **no component-level tests** and no screen-reader testing was done (only roles/labels and keyboard paths were implemented and exercised in Chromium).
6. In-memory rate limits and login throttles are per process; do not run multiple API instances before moving them to shared storage.
7. `npm audit` was clean at the last run; `autocannon` (had a moderate advisory) was removed.
8. The restore procedure needs a superuser; the non-superuser path is documented but not rehearsed.

## Exact next task

**Phase 2, first slice: linked records.** Design in `docs/architecture.md` ("what is deliberately not here"): relational edge table `record_links(workspace_id, field_id, from_record_id, to_record_id)` with composite FKs and RLS, a `link` field type (options: target table, bidirectional pair), validation in `records.ts` (targets must be in the same workspace and table), query support (`has_any`/`is_empty` via EXISTS), UI cell + record-panel picker, tests in the style of `security.test` for cross-tenant link attempts. Before starting, decide with the owner: (a) whether to build field/row policies first (they affect every later leak surface: counts, sorts, lookups, exports), (b) whether to add the superuser provisioning step to the supported deployment path or drop it for managed Postgres.

Other pending items in priority order: field type change with preview/convert; outgoing HTTP actions behind a secret store + SSRF-safe egress (prerequisite for CRM connectors); S3 `BlobStore` adapter + scanner; WAL archiving/PITR; measure on the 2 vCPU/4 GB profile.

## Do not do without explicit authorization

Deploy publicly, connect real CRM accounts, send email, enable AI calls, provision paid infrastructure, or run the connector phase. None of these were done.
