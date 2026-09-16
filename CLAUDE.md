# Signage CRM — CLAUDE.md

This file orients an AI coding agent (or a human) picking this project back
up. The authoritative product specification is
`claude_signage_crm_production_prompt.json` (uploaded alongside this repo,
not committed — see `docs/product-spec-summary.md` for a copy of its key
points). If this file ever conflicts with that spec, the spec wins unless
the user explicitly approves deviating from it. Assumptions made where the
spec was ambiguous are logged in `DECISIONS.md`.

## Current phase

**Phase 1 (Architecture and foundation) is complete.** See `BUILD_STATUS.md`
for the authoritative, up-to-date checklist. Phase 2 (Core CRM — full
leads/deals/pipelines/tasks CRUD, dashboard) is next.

## Architecture

npm workspaces monorepo:

```
apps/api      NestJS API (TypeScript, Express adapter)
apps/web      Next.js 15 (App Router) frontend
packages/db   Prisma schema, migrations, seed data, tenant-scoping helper
packages/shared  Cross-cutting pure utilities (email/phone normalization)
```

- **Database**: PostgreSQL via Prisma. `packages/db/prisma/schema.prisma`
  models the full `minimum_data_model` list from the spec — including
  tables for Phase 3 (communications/telephony) and Phase 4 (workflow
  engine) that no API code touches yet — so later phases don't need
  destructive migrations. Only Phase 1-2 tables (Tenant, User, Role,
  Permission, Contact, Company, Lead, Pipeline, Stage, Deal, Task,
  Activity, AuditLog, etc.) are wired to working endpoints.
- **Tenant isolation**: enforced by a Prisma Client Extension
  (`packages/db/src/tenant-scope.ts`, `forTenant(prisma, tenantId)`) that
  forces `tenantId` into every read/write for tenant-scoped models,
  regardless of what a caller passes. Services obtain a scoped client via
  `TenantPrismaFactory.forTenant(actor.tenantId)`
  (`apps/api/src/common/tenant/tenant-prisma.factory.ts`) — a **plain
  singleton**, not a request-scoped provider. See "Nest gotcha" below for
  why.
- **Auth**: server-side sessions (opaque token in an httpOnly cookie,
  SHA-256 hash stored in the `Session` table), bcrypt password hashing,
  double-submit CSRF cookie/header pair. RBAC via `Role`/`Permission`
  tables seeded with the six roles from the spec's `primary_users` list.
  MFA is **not yet implemented** (tracked in BUILD_STATUS.md).
- **Audit logging**: `AuditService` writes immutable `AuditLog` rows for
  login, login failure, logout, and contact creation so far.

## Nest gotcha: request-scoped controllers silently skip their guards

Empirically verified in this codebase (reproduced with a zero-dependency
debug guard): when a controller becomes request-scoped — which happens
automatically if anything in its constructor dependency chain is
`Scope.REQUEST` — NestJS does **not** reliably invoke that controller's
guards (neither class-level nor method-level `@UseGuards`). The route
handler still runs, silently bypassing auth/permission checks. There was
no error, no warning — just guards that never fired.

**Rule for this codebase: never use `Scope.REQUEST` providers.** Get the
tenantId from `@CurrentUser()` (set by `SessionAuthGuard`, a normal
singleton guard) and pass it explicitly to a singleton factory
(`TenantPrismaFactory.forTenant(tenantId)`). This is what
`ContactsService`/`ContactsController` do — copy that pattern for every
new module.

## Commands

```bash
npm install                                   # install all workspaces

# Database
npm run db:migrate --workspace packages/db    # create/apply a dev migration
npm run db:generate --workspace packages/db   # regenerate Prisma client
npm run db:seed --workspace packages/db       # seed realistic dev data

# Run
npm run dev:api                               # NestJS on :4000 (watch mode)
npm run dev:web                               # Next.js on :3000 (dev mode)

# Verify (run all of these before considering a change done)
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present
npm run test --workspaces --if-present         # unit tests
npm run --workspace apps/api test:e2e          # integration/e2e tests
npm run build --workspaces --if-present
```

Local Postgres/Redis for development (outside Docker): the sandbox this
was built in has no `dockerd`, so Phase 1 was verified against Postgres 16
and Redis running directly on the host (`service postgresql start`,
`redis-server --daemonize yes`). `docker-compose.yml` is written and
`docker compose config` validates, but a real `docker compose up` build
has **not** been executed — see BUILD_STATUS.md "Not executed/tested".

## Coding conventions

- Prisma model names in `TENANT_SCOPED_MODELS` (`packages/db/src/tenant-scope.ts`)
  must stay in sync with `schema.prisma`; add every new tenant-owned model
  to that set or its rows will not be tenant-isolated.
- Every mutation goes through `TenantPrismaFactory`, never through the
  bare `PrismaService` (that's reserved for auth's pre-tenant-resolution
  lookups and system/admin jobs).
- Every mutating (non-GET) endpoint is behind the global `CsrfGuard`
  automatically (registered as `APP_GUARD`); nothing to opt into.
- Add permission keys to `packages/db/src/permissions.ts` (`PERMISSIONS`,
  `DEFAULT_ROLES`) rather than inventing ad hoc strings in controllers.
- Never use `$queryRaw`/`$executeRaw` against tenant-owned tables — it
  bypasses the tenant-scope extension. Use the query builder.
- New API modules: controller + service + DTO with `class-validator`
  decorators, guarded with `@UseGuards(SessionAuthGuard, PermissionsGuard)`
  and `@RequirePermissions(...)`, audit-logged for any mutation.

## Security constraints (from the spec, still binding)

- Never send provider credentials/tokens to the browser.
- No real customer data or secrets — seed data is fictional.
- Encrypt provider credentials at rest (not yet applicable — no external
  providers connected in Phase 1).
- Immutable audit records for logins, exports, merges, assignment
  changes, deal-stage changes, workflow publication, external
  communications.
- Tenant isolation must be enforced in every query and tested (done —
  see `apps/api/test/tenant-isolation.e2e-spec.ts`).

## Verified decisions

See `DECISIONS.md` for the full log with rationale. Headlines:
- Phone normalization defaults to +92 (Pakistan) for bare national
  numbers; a real E.164 library should replace this once other countries
  are onboarded.
- Sessions are server-side + httpOnly cookie, not JWT — simpler to revoke,
  matches "secure server sessions" in the spec's `recommended_stack`.
- `TenantPrismaFactory` is a singleton, not request-scoped — see the Nest
  gotcha above.
