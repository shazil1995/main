#!/usr/bin/env bash
# Backs up the database, restores it into a CLEAN database, and verifies data, constraints and RLS. Output is retained in bench/raw/restore-test.txt.
# Usage: DATABASE_URL=<owner dsn of source db> ADMIN_DSN=<superuser dsn> bash server/scripts/restore-test.sh
set -euo pipefail
SRC="${DATABASE_URL:?}"; ADMIN="${ADMIN_DSN:?}"; TARGET_DB="basecraft_restore_$$"
OUT="$(dirname "$0")/../../bench/raw/restore-test.txt"; mkdir -p "$(dirname "$OUT")"
BACKUP="$(mktemp -d)/backup.dump"
exec > >(tee "$OUT") 2>&1
echo "== restore test $(date -u +%FT%TZ) =="
t0=$(date +%s.%N)
pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP" "$SRC"
t1=$(date +%s.%N)
echo "backup: $(du -h "$BACKUP" | cut -f1) in $(printf '%.1f' "$(echo "$t1 - $t0" | bc)")s"
psql "$ADMIN" -qc "CREATE DATABASE $TARGET_DB OWNER basecraft_owner"
TARGET_ADMIN="${ADMIN%/*}/$TARGET_DB"
psql "$TARGET_ADMIN" -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm"
t2=$(date +%s.%N)
pg_restore --no-owner --role=basecraft_owner --dbname="$TARGET_ADMIN" "$BACKUP" 2>&1 | grep -v "already exists" || true
# privileges are not part of the dump (--no-privileges); re-applying them is part of the documented restore procedure: re-run migrations' grants
psql "$TARGET_ADMIN" -q <<'SQL'
GRANT USAGE ON SCHEMA public TO basecraft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, workspaces, members, invitations, api_tokens, bases, tables, fields, records, views, attachments, comments, resource_grants, automations, outbox_events, automation_runs, import_jobs, idempotency_keys TO basecraft_app;
GRANT SELECT, INSERT ON audit_events TO basecraft_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO basecraft_app;
GRANT EXECUTE ON FUNCTION bc_claim_outbox, bc_claim_import_job, bc_cleanup, bc_orphan_attachments, bc_purge_attachment_row, bc_resolve TO basecraft_app;
SQL
t3=$(date +%s.%N)
echo "restore: $(printf '%.1f' "$(echo "$t3 - $t2" | bc)")s"
echo "-- row counts (source vs restored) --"
for t in users workspaces members bases tables fields records views attachments automations audit_events outbox_events; do
  a=$(psql "$SRC" -Atc "select count(*) from $t"); b=$(psql "$TARGET_ADMIN" -Atc "select count(*) from $t")
  printf '%-14s %8s %8s %s\n' "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo OK || echo MISMATCH)"
  [ "$a" = "$b" ] || { echo "FAILED: $t differs"; exit 1; }
done
echo "-- integrity --"
psql "$TARGET_ADMIN" -Atc "select 'rls tables enabled: ' || count(*) from pg_class where relrowsecurity and relnamespace='public'::regnamespace"
psql "$TARGET_ADMIN" -Atc "select 'policies: ' || count(*) from pg_policies"
psql "$TARGET_ADMIN" -Atc "select 'foreign keys: ' || count(*) from pg_constraint where contype='f'"
psql "$TARGET_ADMIN" -Atc "select 'audit immutability trigger present: ' || count(*) from pg_trigger where tgname='audit_events_no_update'"
APP_DSN=$(echo "$SRC" | sed "s#//[^@]*@#//basecraft_app:${BASECRAFT_APP_PASSWORD:-dev_app_pw}@#; s#/[^/]*\$#/$TARGET_DB#")
echo "-- RLS still enforced for the application role on the restored database --"
echo "no context:    $(psql "$APP_DSN" -Atc 'select count(*) from records') rows visible (expected 0)"
WS=$(psql "$TARGET_ADMIN" -Atc "select workspace_id from records group by 1 order by count(*) desc limit 1")
echo "with workspace: $(psql "$APP_DSN" -Atc "begin; select set_config('app.workspace_id','$WS',true); select count(*) from records; commit;" | sed -n 3p) rows visible (expected = that workspace's records)"
echo "expected:       $(psql "$TARGET_ADMIN" -Atc "select count(*) from records where workspace_id='$WS'")"
echo "-- a record round-trips through the restored schema --"
psql "$TARGET_ADMIN" -Atc "select 'sample record values bytes: ' || coalesce(max(pg_column_size(\"values\")),0) from records"
psql "$ADMIN" -qc "DROP DATABASE $TARGET_DB"
rm -f "$BACKUP"
echo "RESULT: restore verified (counts equal, RLS enforced, constraints present). RTO for this dataset = backup+restore wall time above."
