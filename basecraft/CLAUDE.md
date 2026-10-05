# Basecraft — agent orientation

Self-hosted Airtable-style data tool. **This directory is independent of the Signage CRM that lives elsewhere in the repo;
do not mix them.** Current state and next task: `HANDOFF.md`. Parity truth: `FEATURE_PARITY.md`.

## Commands (run from `basecraft/`)
```bash
npm install && npm run build            # shared → server → web (shared must be built before server/web type-check)
npm test                                # server needs Postgres: DB `basecraft_test`, roles basecraft_owner/basecraft_app
npm run typecheck
npm run db:migrate | db:seed | openapi  # `openapi` rewrites docs/openapi.json (commit it when routes change)
npm run dev:api | dev:web
npm run e2e -w web                      # needs a running server + DEMO_PASSWORD from db:seed
```
Never use `pkill -f` with a pattern that appears in your own command line; start servers with `setsid nohup … &`.

## Invariants (do not break; each has a test)
1. Request traffic uses `APP_DATABASE_URL` (role `basecraft_app`, RLS enforced). The owner pool is for migrations/tests/DDL like `CREATE INDEX CONCURRENTLY`.
2. Workspace-scoped data is only touched inside `withWorkspace()` (sets `app.workspace_id` per transaction). Add `workspace_id` + RLS policy + composite FK for every new content table; extend the table list in migration `0001` style (new migration, never edit applied ones — checksums are enforced).
3. Every route is declared through `reg({... scope:{resource,param,permission} ...})` so authz, 404-vs-403, CSRF, rate limits, audit and OpenAPI come for free. Unknown body keys are rejected (`.strict()`); never trust client-supplied ownership.
4. All record writes go through `records.ts` (validation, version check, audit, outbox in one transaction). Imports, forms, automations and the API share it.
5. Values: decimals are strings, `false`/`0` are values, empty removes the key. Never parse money as float. Datetimes: offset required unless the field has a time zone.
6. SQL: parameterise values; field ids are inlined only after matching the table's UUID field list (`query.ts`). No `$queryRaw`-style concatenation of client text.
7. Tokens: never grant admin/schema/automation/member endpoints (`auth:'session'` routes) and never log or return stored token values.
8. Do not add outgoing HTTP/email/AI features without a secret store, approval flow, SSRF controls and budgets (see FEATURE_PARITY Phase 3/4).

## Conventions
TypeScript strict + `noUncheckedIndexedAccess`; zod for validation; small route handlers; web talks to the API only via `src/api.ts` and `src/lib/queries.ts` (`useRecords` is the single record source for all views).
Docs must not claim more than tests/benchmarks show — update `FEATURE_PARITY.md` statuses with evidence when you change behaviour.
