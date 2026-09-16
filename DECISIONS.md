# Decisions and Assumptions Log

Chronological log of decisions and assumptions made while implementing
Phase 1 (Architecture and foundation) of the Signage CRM, per
`implementation_principles`: "Where a requirement is ambiguous, implement
the safest conventional CRM behaviour, record the assumption here, and
continue unless credentials or an irreversible external action are
required."

## 0. Starting state of the repository

The task described this as a "continuation" of an existing project and
asked to read `BUILD_STATUS.md`, `FILE_MANIFEST.json`, and `DECISIONS.md`
from prior work. At the start of this session, the target repository
(`shazil1995/main`) had **zero commits and zero files**, and none of
those three files existed anywhere in the uploaded materials either —
only the product spec JSON was provided. There was no prior
implementation to preserve. This was flagged to the user before writing
any code, then treated as the legitimate start of Phase 1 (the first
incomplete phase, since none exist yet).

## 1. Multi-tenancy: enforcement mechanism

**Decision**: tenant isolation is enforced by a Prisma Client Extension
(`forTenant(prisma, tenantId)` in `packages/db/src/tenant-scope.ts`) that
intercepts every query against a fixed list of tenant-scoped models and
forcibly injects/overwrites `tenantId` in `where`/`data`, regardless of
what the caller passed. `findUnique` (which must use only unique-key
fields in `where`, so `tenantId` can't be injected there) is instead
checked post-query: if the row's `tenantId` doesn't match, it's treated
as not found.

**Rationale**: the spec requires tenant isolation "enforced in every
query and tested," not "remembered by every developer in every query." A
structural guarantee (extension-level) is safer than a convention
(remembering a `where: { tenantId }` clause by hand in every service
method). Verified in `apps/api/test/tenant-isolation.e2e-spec.ts`: two
real tenants, real HTTP requests, real Postgres — cross-tenant list/read
attempts return empty/404, never another tenant's data.

**Known gap**: `$queryRaw`/`$executeRaw` bypass the extension entirely.
Documented in CLAUDE.md as a hard "never do this" rule. No raw queries
exist in the codebase today.

## 2. NestJS request-scoped providers silently skip route guards

While building the tenant-scoping mechanism, the first implementation
used a `Scope.REQUEST` provider (`TenantPrismaService`, injecting
`REQUEST` to read `request.tenantId` set by `SessionAuthGuard`). This
made `ContactsController` request-scoped transitively.

**Symptom**: `SessionAuthGuard` and `PermissionsGuard` never ran for
`ContactsController`'s routes — not "ran and failed," but never invoked
at all. Confirmed with a zero-dependency debug guard
(`canActivate() { console.log(...); return true; }`) that also never
logged. `/auth/me` (on a normal singleton `AuthController`) worked fine
with the identical guard classes. The only difference was the
request-scoped controller.

**Decision**: never use `Scope.REQUEST` in this codebase.
`TenantPrismaFactory` is a plain singleton with a `forTenant(tenantId)`
method; controllers pass `tenantId` from `@CurrentUser()` (populated by
the now-definitely-running `SessionAuthGuard`) explicitly. This is
slightly more verbose per call site but sidesteps the bug entirely and
keeps every route's authorization guaranteed to actually execute.
Documented in `CLAUDE.md` so nobody reintroduces `Scope.REQUEST` later.

## 3. Session-based auth, not JWT

**Decision**: opaque random session tokens (32 random bytes, base64url)
in an httpOnly cookie; only the SHA-256 hash is stored server-side
(`Session.tokenHash`). No JWT.

**Rationale**: the spec's `recommended_stack.authentication` says
"standards-based OIDC with secure server sessions" — sessions, not
stateless JWTs. Server-side sessions are trivially revocable (delete/mark
`revokedAt`), which matters for the spec's "session revocation" security
requirement; a signed JWT would remain valid until expiry even after
"logout" unless a denylist is maintained anyway (at which point you've
reinvented server-side sessions with extra steps).

## 4. CSRF: double-submit cookie/header

**Decision**: `GET /auth/csrf` issues a random token in a non-httpOnly
cookie; every mutating request must echo it in `x-csrf-token`. Enforced
globally via `APP_GUARD` (`CsrfGuard`), skipped only for
GET/HEAD/OPTIONS.

**Rationale**: standard, dependency-free double-submit pattern. Because
the session cookie is `SameSite=Lax`, classic CSRF via a naive cross-site
form is already narrowed, but the double-submit token also protects
against `SameSite=None`/misconfigured deployments and is cheap to
implement without pulling in a session-store-specific CSRF library.

## 5. Login rate limiting is in-memory, single-process

**Decision**: `LoginRateLimiter` (fixed window, 10 attempts / 15 minutes,
keyed by normalized email + IP) is a plain in-memory `Map`.

**Limitation, explicitly not fixed now**: this does not share state
across multiple API instances/processes. Production hardening (Phase 5)
should replace it with a Redis-backed limiter (Redis is already in the
stack for BullMQ). Tracked in BUILD_STATUS.md.

## 6. MFA not implemented

The spec asks for "optional MFA support." `User.mfaEnabled` /
`mfaSecretEnc` columns exist in the schema as placeholders, but no
TOTP enrollment/verification flow was built in Phase 1. Tracked as a
known limitation.

## 7. `User.normalizedEmail` is globally unique, not per-tenant

**Decision**: a user's normalized email is unique across the whole
system, not just within their tenant.

**Rationale**: this is an internal company CRM (signage business), not a
multi-company SaaS marketplace where the same email might legitimately
belong to different customer organizations. A global unique constraint
keeps login simple (look up by email, no tenant selection step) while the
`Tenant` model and the tenant-scoping extension still exist and are fully
tested, so the architecture would still support relaxing this later if
the business becomes a true multi-tenant SaaS product.

## 8. Phone normalization defaults to +92 (Pakistan)

**Decision**: `normalizePhoneToE164` (`packages/shared/src/normalize.ts`)
defaults bare national numbers (no `+`, no `00` prefix) to country code
92, and does no other validation beyond digit-count sanity checks.

**Rationale**: the spec's `product_context.timezone` is `Asia/Karachi`
and `default_currency` is `PKR` — this is a Pakistan-based signage
business, so most bare phone numbers entered will be local. This is
**not** a substitute for a real phone-number library.

**Follow-up needed before onboarding customers outside Pakistan**:
replace with `google-libphonenumber` or equivalent, parameterized by
tenant's country.

## 9. Full `minimum_data_model` modeled up front, not phased in

**Decision**: `packages/db/prisma/schema.prisma` includes tables for
every entity in the spec's `minimum_data_model` list — including Phase
3 (telephony, email/mailbox, consent/suppression) and Phase 4 (workflow
engine) tables — even though no API code touches most of them yet.

**Rationale**: `implementation_principles` says "generate migrations and
do not rely on automatic schema synchronization in production." Adding
~30 more tables in a later phase alongside dozens of new foreign keys
into already-live tables (e.g., `Activity.callId`, `Activity.emailMessageId`)
is far riskier as a *later* migration against a database with real data
than as part of the initial migration. The cost is a larger initial
schema; the benefit is no destructive Phase 3/4 migrations later. Each
"future" table is commented in the schema explaining which phase wires it
up.

## 10. Contacts implemented in Phase 1 as the tenant-isolation vertical slice

The spec's Phase 1 outputs list "authentication and tenant isolation" but
Phase 2 owns the actual CRM CRUD. A minimal Contacts endpoint (list, get,
create) was built in Phase 1 anyway, specifically to give the tenant-scope
extension and RBAC guards a real, testable, end-to-end path (through a
real controller/service/Prisma model) rather than proving isolation only
in the abstract. It doubles as the first real building block for Phase 2's
full Contacts module and as the working feature shown in the web app's
dashboard.

## 11. Docker Compose is written but not build-tested

**Decision/limitation**: `docker-compose.yml` and the two Dockerfiles are
written following standard multi-stage build practices for an npm
workspaces monorepo, and `docker compose config` validates the YAML
successfully. However, this sandbox has no running Docker daemon
(`dockerd`), so an actual `docker compose up --build` has **not** been
executed. Phase 1 was verified instead by running Postgres 16 and Redis
directly on the host and running the API/web apps with `node`/`next
start` directly. This must be validated in an environment with Docker
before relying on it. Tracked in BUILD_STATUS.md.

## 12. Seed data uses one shared password across all seeded users

All seeded users (`admin@brightsigns.pk`, `manager@brightsigns.pk`, etc.)
share the password `Passw0rd!123`, bcrypt-hashed. This is standard
practice for local/dev seed data and is called out explicitly here and in
`BUILD_STATUS.md`/README so nobody mistakes it for production credentials
or ships it as-is.

## 13. Audit log write is not in the same DB transaction as the mutation it records

`AuditService.log()` runs as a separate `prisma.auditLog.create()` call
after the primary mutation (e.g., `contact.created` after
`client.contact.create()`), not inside a shared transaction. If the
process crashes between the two calls, the mutation succeeds but is not
audited. Acceptable for Phase 1's scope; flagged for Phase 2+ as a
candidate for wrapping mutation + audit write in `prisma.$transaction`.

---

## Threat model (Phase 1 scope)

See `THREAT_MODEL.md` for the full write-up (assets, trust boundaries,
STRIDE-style walkthrough of the auth/tenant-isolation/CSRF surface built
in this phase, and mitigations already in place vs. deferred).
