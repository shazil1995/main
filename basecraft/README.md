# Basecraft

A self-hostable, independently branded structured-data workspace (tables, typed fields, views, forms, automations, API) —
an Airtable-style alternative. **Phase 1 of the roadmap is implemented**; see `FEATURE_PARITY.md` for exactly what works,
what is partial and what is not built, and `HANDOFF.md` for the current state and next task.

Not "production ready", not a complete Airtable replacement, and not API-compatible with Airtable.

## Quick start (development)

Requirements: Node ≥ 22, PostgreSQL 16 (with `pg_trgm`, a standard contrib extension).

```bash
cd basecraft
npm install
cp .env.example .env            # then edit the placeholders; never commit .env
npm run db:init                 # creates db + roles (needs a Postgres superuser DSN in ADMIN_DATABASE_URL)
npm run db:migrate
npm run build                   # builds shared, server and web
npm run dev:api                 # API on :4100 (also serves web/dist if built)
npm run dev:web                 # optional: Vite dev server on :5173 proxying /api
```

Open http://localhost:4100 (or :5173 in dev), **Create an account**, then create a base → table, add fields and records,
save views, import a CSV, build an automation, and create an API token.

Optional, explicit: `npm run db:seed` loads a **fictional** signage-company example (customers, 60 projects, board/calendar/
gallery/form views, one automation) and prints a one-time demo password. New workspaces are otherwise empty.

Docker: `docker compose up --build` (needs `POSTGRES_ADMIN_PASSWORD`, `BASECRAFT_OWNER_PASSWORD`, `BASECRAFT_APP_PASSWORD`,
`SERVER_SECRET` in the environment). The compose file was only syntax-checked in the build sandbox.

## Verify

```bash
npm run typecheck && npm test                       # 100+ server tests against a real Postgres (basecraft_test) + web unit tests
npm run build && DEMO_PASSWORD=… npm run e2e -w web # 26-step Chromium run against a seeded, running server
npm run bench -w server                             # 100k-record load test → bench/raw/*, see PERFORMANCE.md
```

## Using the API

`GET /api/v1/openapi.json` (also committed as `docs/openapi.json`). Create a token in **Workspace → API tokens**, then:

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:4100/api/v1/tables/$TABLE/records?limit=5"
```

Working TypeScript and Python clients and a custom-CRM idempotent-upsert example are in `docs/examples/`. Updates need
`If-Match: "<version>"`; creates accept `Idempotency-Key`; lists use opaque cursors.

## Documents

`FEATURE_PARITY.md` · `docs/architecture.md` · `SECURITY.md` · `PERFORMANCE.md` · `COST_MODEL.md` · `docs/BACKUP_RESTORE.md` ·
`MIGRATION.md` · `HANDOFF.md` · `CLAUDE.md` (agent orientation)

## Layout

```
shared/   dependency-free types, field/operator tables, role matrix
server/   Fastify API, migrations (SQL), worker, scripts (seed, bench, openapi, restore test), tests
web/      React client, unit tests, Chromium e2e script
docs/     architecture, backup/restore, OpenAPI, examples
bench/    raw load-test output and EXPLAIN plans
```
