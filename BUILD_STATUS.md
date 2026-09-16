# Build Status

Authoritative progress tracker. Update this (and `FILE_MANIFEST.json`)
whenever a phase or vertical slice completes. See `README.md` for
setup/test-results and `DECISIONS.md` for the reasoning behind choices
made along the way.

## Phase 1 — Architecture and foundation: **COMPLETE**

- [x] Repository/monorepo scaffold (npm workspaces: `apps/api`,
      `apps/web`, `packages/db`, `packages/shared`)
- [x] Data model covering the full `minimum_data_model` list, as a
      single Prisma schema + migration (`packages/db/prisma/schema.prisma`,
      migration `20260916101208_init`)
- [x] Authentication (server-side sessions, bcrypt, CSRF double-submit,
      login rate limiting)
- [x] Tenant isolation, enforced structurally (Prisma Client Extension)
      and verified by an e2e test with two real tenants
- [x] RBAC (Role/Permission tables, seeded with the spec's six
      `primary_users` roles, enforced via guards)
- [x] Audit logging (login, login-failure, logout, contact-created)
- [x] Seed data: one tenant ("Bright Signs Co"), six users (one per
      role), a team, two lead sources, a 7-stage pipeline, two loss
      reasons, a company, three contacts, a lead, a converted deal with
      signage-specific details, a task, an activity
- [x] One working vertical-slice business endpoint (Contacts:
      list/get/create) proving the auth + tenant-isolation + RBAC +
      audit pattern end-to-end, ready to be copied for Phase 2 modules
- [x] Minimal Next.js web app: login page, dashboard (current user,
      contacts table, add-contact form gated by permission, sign out)
- [x] Docker Compose + Dockerfiles for api/web (written; see "Not
      executed/tested" below)
- [x] Architecture/decisions/threat-model docs (`CLAUDE.md`,
      `DECISIONS.md`, `THREAT_MODEL.md`)
- [x] Automated tests: unit (auth service, permissions guard, csrf
      guard, phone/email normalization) + e2e (tenant isolation, CSRF,
      session requirement) — all passing, see README.md "Test results"
- [x] `typecheck`, `lint`-equivalent (tsc strict mode), and production
      builds all succeed for both apps

### Known limitations carried forward (see DECISIONS.md for detail)

- No MFA implementation (placeholder columns only)
- Login rate limiter is in-memory/single-process only
- Phone normalization defaults to +92, not a full E.164 library
- Audit write not transactional with the mutation it records

## Phase 2 — Core CRM: **NOT STARTED**

Planned outputs (from the spec): full Leads/Contacts/Companies/Deals/
Pipelines/Tasks CRUD with search/filter/tag/assign/archive, dashboard
aggregations (new leads, unassigned leads, overdue follow-ups, calls due
today, pipeline value by stage, conversion rate, agent activity,
lead-source performance), Kanban stage moves, lead-to-deal conversion,
bulk actions with permission checks and audit logging, custom fields.

Recommended approach: copy the `apps/api/src/contacts/*` pattern for each
new entity (controller + service + DTO, `SessionAuthGuard` +
`PermissionsGuard` + `@RequirePermissions`, `TenantPrismaFactory`,
`AuditService`), then build dashboard read-model endpoints last since
they aggregate across the others.

## Phase 3 — Airtable and communications: **NOT STARTED**

Schema exists for LeadSource/ExternalRecordMap/SyncRun/WebhookEvent
(Airtable) and MailboxConnection/EmailThread/EmailMessage/TelephonyConnection/
Call/CallRecording/CallTranscript/CommunicationConsent/SuppressionEntry
(communications), per Decision #9 in DECISIONS.md, but no adapters,
ingestion jobs, OAuth flows, or UI exist yet.

## Phase 4 — Visual automation engine: **NOT STARTED**

Schema exists for Workflow/WorkflowVersion/WorkflowEnrollment/WorkflowRun/
WorkflowStepRun. No canvas UI, execution engine, or BullMQ workers exist
yet. Redis is configured in Docker Compose but nothing consumes it.

## Phase 5 — Hardening and release: **NOT STARTED**

## Not executed/tested in this environment

Listed here explicitly per the task's request to call out anything that
could not be run:

- **`docker compose up --build`**: this sandbox has no running Docker
  daemon (`dockerd`). `docker compose config` validates the YAML/Dockerfile
  references successfully, but the actual multi-stage image builds and
  container startup were never executed. Verify in a real Docker
  environment before depending on it.
- **Real OAuth/telephony/Airtable/S3 provider integration**: none exist
  yet (Phase 3+); nothing to test.
- **Load testing, backup/restore drill**: Phase 5 scope, not started.
- **Multi-instance/distributed rate limiting**: not implemented (see
  Decision #5), so nothing to test.

## What WAS executed and verified in this environment

- PostgreSQL 16 and Redis run directly on the host (no Docker) —
  `service postgresql start`, `redis-server --daemonize yes`.
- `npx prisma migrate dev` created and applied the initial migration
  against a real Postgres database.
- The seed script ran successfully and is idempotent (`upsert`-based)
  against that real database.
- The NestJS API was built (`nest build`) and run (`node dist/main.js`)
  against that real database; exercised with `curl` for login, CSRF,
  RBAC-denial (403), tenant-isolation (a second ad hoc tenant confirmed
  it saw zero of the first tenant's contacts and got 404 on a direct ID
  guess), then formalized into the automated e2e suite against a
  dedicated `signage_crm_test` database.
- The Next.js web app was built (`next build`) and run (`next start`)
  against the real running API.
- A full browser session (headless Chromium via Playwright, used only as
  an ad hoc manual-verification tool for this session — not added as a
  project dependency) drove the actual golden path: load `/login` → sign
  in as `agent@brightsigns.pk` → land on `/dashboard` → see "Hamza Farooq
  · sales_agent" → see the seeded contacts table → submit the add-contact
  form → see the new row appear → sign out → redirected back to
  `/login`. All steps passed with no unexpected console errors.
