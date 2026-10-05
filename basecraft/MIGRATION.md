# Migration and compatibility guide

## From the hosted reference MVP (React/Vinext + Cloudflare D1)

The source of that MVP was not supplied, so **nothing was imported** and no compatibility is claimed. The portable path is:

1. In the reference app use *Export* (CSV, per table). The reference export is the **current page** only — page through or export in several passes; verify row counts.
2. In Basecraft create a base/table and fields of the matching types, then use **Import CSV** (mapping + preview + validation report). Select options must exist first (they are not auto-created); yes/no and thousands separators are converted; datetimes need an explicit offset unless the field has a time zone.
3. Re-create saved views, rules (as Basecraft automations) and API tokens by hand — tokens cannot be migrated (hashed, different format).
4. Verify counts with `POST /tables/{id}/records/query {include_total:true}` and spot-check values.

Known differences from the reference: multi-user roles and invitations exist; field types cannot yet change after creation; automations are asynchronous (outbox + worker) rather than synchronous in the write; API pagination is cursor-based (not offset); PATCH merges only the supplied fields; tokens never grant schema/admin access.

## From Airtable (not a drop-in)

Basecraft does **not** implement the Airtable REST API. Differences that will break naive ports:

| Airtable habit | Basecraft |
|---|---|
| address fields by display name | stable **field UUIDs** only (names can change) |
| `offset` pagination | opaque `cursor` (`next_cursor`/`prev_cursor`), bounded page size ≤ 500 |
| `PATCH`/`PUT` with typecast | strict typing; `PATCH` merges, `null` clears; no `typecast` |
| last-write-wins | `If-Match: "<version>"` required → `412` with current record |
| linked records/lookups/rollups/formulas | **not implemented** (Phase 2) |
| rate limit 5 req/s/base | per-token and per-workspace token bucket, `429` + `Retry-After` |
| webhooks | not implemented |

A compatibility adapter would need its own spec and verification against Airtable's documented behaviour; none exists. The
Airtable docs could not be consulted in this build (network blocked), so treat this table as *design intent*, not a verified diff.

## Moving Basecraft to another host/database

* Database: `pg_dump --format=custom` + `pg_restore` (see `docs/BACKUP_RESTORE.md`); then re-apply grants (`GRANT … TO basecraft_app`) or run `npm run db:migrate` on an empty DB and `pg_restore --data-only`. Roles are cluster-level: create `basecraft_owner` / `basecraft_app` first (`npm run db:init`).
* Files: copy `ATTACHMENT_DIR` (keys are `<workspace-uuid>/<uuid>`; the DB row names the key). Orphans are removed by the maintenance job.
* Changing storage backend: implement `BlobStore` (put/get/delete/list) for S3-compatible storage and copy objects by key; no DB change needed.
* Changing runtime/DB engine: not planned. The query layer is Postgres-specific (JSONB operators, `pg_trgm`, RLS).

## Schema/data migrations

SQL files in `server/migrations/` run in order under an advisory lock as the owner role (`npm run db:migrate`); applied files are
checksummed (editing an applied migration fails loudly). Migrations are never run by request handling. There is no automatic
down-migration: write a forward fix or restore from backup. For large backfills use checkpointed batches outside a single
transaction (the import job is the reference pattern).
