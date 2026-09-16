# Signage CRM

Multi-tenant CRM for a business-signage company. See
`claude_signage_crm_production_prompt.json` for the full product
specification, `BUILD_STATUS.md` for what's built, `DECISIONS.md` for
assumptions made, and `CLAUDE.md` for architecture/conventions.

**Current status: Phase 1 (Architecture and foundation) complete.**

## Setup (without Docker — verified in this environment)

Prerequisites: Node.js 20+, PostgreSQL 16 running locally, npm.

```bash
# 1. Install dependencies (npm workspaces: installs api, web, db, shared)
npm install

# 2. Create the database and point Prisma at it
createdb signage_crm   # or: psql -c "CREATE DATABASE signage_crm OWNER <you>;"
cp packages/db/.env.example packages/db/.env   # edit DATABASE_URL if needed
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local

# 3. Run migrations and seed realistic dev data
npm run db:migrate --workspace packages/db
npm run db:seed --workspace packages/db

# 4. Start both apps (two terminals)
npm run dev:api    # http://localhost:4000/api
npm run dev:web    # http://localhost:3000
```

Open http://localhost:3000/login.

## Setup (Docker Compose — written, NOT build-tested)

```bash
cp .env.example .env
docker compose up --build
```

`docker compose config` validates the compose file successfully in this
environment, but there is no Docker daemon available in the sandbox this
was built in, so the actual image builds and container startup have
**not** been run end-to-end. Validate this in a real Docker environment
before relying on it. After the containers are up, seed data with:

```bash
docker compose exec api sh -c "cd packages/db && npx prisma db seed"
```

## Sample login (seeded users)

All seeded users share the password `Passw0rd!123` (bcrypt-hashed in the
database — this is dev-only seed data, never real credentials):

| Email | Role |
|---|---|
| admin@brightsigns.pk | administrator |
| manager@brightsigns.pk | sales_manager |
| caller@brightsigns.pk | calling_agent |
| agent@brightsigns.pk | sales_agent |
| designer@brightsigns.pk | designer_or_estimator |
| analyst@brightsigns.pk | read_only_analyst |

`agent@brightsigns.pk` and `admin@brightsigns.pk` can create contacts;
`analyst@brightsigns.pk` can only view them (try both to see the RBAC
guard in action).

## Environment variables

See `.env.example` (root, for Docker Compose), `apps/api/.env.example`,
`apps/web/.env.local.example`, and `packages/db/.env.example`. Summary:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, db | Postgres connection string |
| `API_PORT` | api | Port the NestJS API listens on (default 4000) |
| `WEB_ORIGIN` | api | Allowed CORS origin for the web app |
| `NODE_ENV` | api | `production` enables `secure` cookies |
| `NEXT_PUBLIC_API_URL` | web | Base URL the browser calls for the API |
| `REDIS_URL` | (reserved) | Not yet used by any Phase 1-2 code; for Phase 4 BullMQ workers |

## Test results (last run in this environment)

```
apps/api unit tests:      12 passed, 12 total (3 suites)
apps/api e2e tests:        6 passed, 6 total  (tenant-isolation.e2e-spec.ts)
packages/shared unit tests: 5 passed, 5 total
apps/api  typecheck:       clean
apps/web  typecheck:       clean
apps/api  production build: succeeds (nest build)
apps/web  production build: succeeds (next build)
Browser smoke test (Playwright, headless Chromium):
  login → dashboard → contact list renders → create contact via UI
  → new contact appears → logout → redirected to /login   [all passed]
```

## Known limitations (Phase 1)

- MFA is not implemented (schema placeholder only).
- Login rate limiting is in-memory/single-process, not shared across
  API instances — see `DECISIONS.md` #5.
- Docker Compose is written but not build-tested (no Docker daemon in
  this sandbox) — see `DECISIONS.md` #11.
- Phone normalization defaults to Pakistan (+92) for bare national
  numbers and is not a full E.164 library — see `DECISIONS.md` #8.
- Only Contacts has a working CRUD-ish API today (list/get/create); the
  rest of the core CRM (Leads, Deals/Pipelines, Tasks, Companies,
  dashboard, search/filters) is Phase 2, not yet built.
- No general per-IP API rate limiting, only login-specific — see
  `THREAT_MODEL.md`.
- Audit-log write is not transactional with the mutation it records —
  see `DECISIONS.md` #13.

## Next recommended step

Start Phase 2 (Core CRM): build out Company/Lead/Deal/Pipeline/Task
modules following the exact pattern established by
`apps/api/src/contacts/*` (controller + service + DTO, guarded by
`SessionAuthGuard` + `PermissionsGuard`, tenant-scoped via
`TenantPrismaFactory`, audited via `AuditService`), add the dashboard
aggregation endpoints, and extend the e2e suite to cover lead-to-deal
conversion and Kanban stage moves. Before that, validate the Docker
Compose setup in a real Docker environment, since Phase 2 development
will benefit from a disposable, reproducible local stack.
