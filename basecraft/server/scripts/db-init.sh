#!/usr/bin/env bash
# Creates the database, the two roles (owner for migrations, app for requests) and extensions. Run once per environment as a Postgres superuser.
# Usage: ADMIN_DATABASE_URL=postgres://postgres:...@host:5432/postgres BASECRAFT_OWNER_PASSWORD=... BASECRAFT_APP_PASSWORD=... [DB_NAME=basecraft] bash server/scripts/db-init.sh
set -euo pipefail
: "${ADMIN_DATABASE_URL:?}" "${BASECRAFT_OWNER_PASSWORD:?}" "${BASECRAFT_APP_PASSWORD:?}"
DB="${DB_NAME:-basecraft}"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v owner_pw="$BASECRAFT_OWNER_PASSWORD" -v app_pw="$BASECRAFT_APP_PASSWORD" <<SQL
SELECT format('CREATE ROLE basecraft_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='basecraft_owner') \gexec
SELECT format('CREATE ROLE basecraft_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='basecraft_app') \gexec
SELECT 'CREATE DATABASE $DB OWNER basecraft_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='$DB') \gexec
SQL
psql "${ADMIN_DATABASE_URL%/*}/$DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
echo "database '$DB' ready. Next: npm run db:migrate"
