# Backup and restore

A backup is only considered valid after it has been **restored into a clean database and checked**. `server/scripts/restore-test.sh`
does exactly that and keeps its output in `bench/raw/restore-test.txt`.

## What must be backed up

| asset | how | notes |
|---|---|---|
| PostgreSQL database (all metadata, records, audit, jobs, sessions, token hashes) | `pg_dump --format=custom` | includes owners, ACLs and the superuser-provisioned helper functions/operator class |
| attachment blobs | copy `ATTACHMENT_DIR` (`<workspace-uuid>/<uuid>` files) | the DB row names the key; back up the **DB and files from the same moment** or run the orphan cleaner after restore |
| in-flight import files | `IMPORT_DIR` (optional) | only needed to resume a failed import; safe to lose (re-upload) |
| configuration/secrets | your secret manager | `SERVER_SECRET` signs cursors only; losing it just invalidates open cursors. DB passwords live outside the repo |

Not needed: Redis/queues (none), search index (trigram index is rebuilt by restore).

## Procedure

```bash
# backup (as the owner role is enough)
pg_dump --format=custom --file=basecraft-$(date -u +%FT%H%MZ).dump "$DATABASE_URL"
tar -C "$ATTACHMENT_DIR" -cf attachments-$(date -u +%FT%H%MZ).tar .

# restore into a NEW database, as a SUPERUSER (the dump contains superuser-created LEAKPROOF functions and an operator class)
psql "$ADMIN_DSN" -c "CREATE DATABASE basecraft OWNER basecraft_owner"
pg_restore --exit-on-error --dbname "postgres://postgres:…@host/basecraft" basecraft-….dump
tar -C "$ATTACHMENT_DIR" -xf attachments-….tar
# roles basecraft_owner / basecraft_app must exist first (npm run db:init creates them)
npm run db:migrate          # no-op if the dump is current; applies newer migrations otherwise
```

If you must restore without a superuser, restore the schema with `pg_restore` skipping the helper objects, run `npm run db:migrate`
(migration 0004 installs the non-leakproof fallbacks) — everything works, but filters/search are slower at scale (see `PERFORMANCE.md`).

## Verified result (2026-10-05, this repository)

`bash server/scripts/restore-test.sh` against the 100k-record benchmark database (single host, local disk):

| | |
|---|---|
| dataset | 106,048 records, 106,531 audit rows, 20 fields, 1 workspace |
| backup | **16 MB in 2.0 s** (custom format, compressed) |
| restore into a clean database | **7.1 s** |
| verification | row counts equal for 12 tables; 14 tables with RLS enabled, 14 policies, 31 foreign keys, audit-immutability trigger present; `basecraft_app` sees **0** rows without a workspace context and exactly the workspace's **106,048** with one; leakproof fast paths intact (`proleakproof = t`) |


## RPO / RTO — what you can and cannot promise

* **RPO** = time since the last successful dump (+ blob copy). Logical dumps only: there is **no point-in-time recovery** and no WAL archiving in this build. If you need minutes-level RPO, add WAL archiving/streaming replication (not provided).
* **RTO** for a dataset like the one above is dominated by restore time (seconds here) plus provisioning a host and restoring blobs (not measured). Larger datasets scale roughly with database size; **only 106k records were tested**.
* Restores were tested on the same host and Postgres version (16.14). Cross-version restores, restoring to a different OS, and restoring blobs from object storage were not tested.
* The test does not exercise a corrupted-backup scenario or a restore under load.

## Not covered

Encrypted backups, off-site copies, retention policy automation, restore of a single workspace/table (the dump is whole-database), and checking that restored attachments match their stored SHA-256 (the hash is recorded; a verification pass is a follow-up).
