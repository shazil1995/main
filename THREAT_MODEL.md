# Threat Model — Phase 1 (Architecture and Foundation)

Scope: authentication, session management, tenant isolation, RBAC, and
the one working business endpoint (Contacts). Later phases (Airtable
ingestion, connected email/telephony, workflow engine) will need their
own additions to this document as they're built — this covers only what
exists today.

## Assets

- Tenant data (contacts, companies, leads, deals, tasks, activities).
- Credentials: user password hashes, session tokens.
- Audit trail integrity (who did what, when).
- Availability of the API for legitimate tenant users.

## Trust boundaries

```
Browser (untrusted)
   │  HTTPS (prod) / HTTP (local dev only)
   ▼
Next.js web app  ── same-origin-ish (same eTLD+1, different port in dev)
   │  fetch() with credentials: "include"
   ▼
NestJS API  ── trust boundary: everything past here is "inside"
   │
   ▼
PostgreSQL (single shared instance, tenant column on every row)
```

The API is the only component that talks to Postgres. The web app never
holds a database connection or a service credential; it only holds
whatever cookies the browser gives it (and the httpOnly session cookie is
inaccessible to its own JavaScript by design).

## STRIDE walkthrough

### Spoofing

- **Password guessing / credential stuffing**: mitigated by bcrypt (cost
  factor 12) and `LoginRateLimiter` (10 attempts / 15 min per
  email+IP). *Gap*: limiter is in-memory and per-process — see
  DECISIONS.md #5. Does not protect against distributed credential
  stuffing across many IPs; that needs a WAF/edge rate limit in
  production, out of scope for Phase 1.
- **Session token guessing**: 256 bits of randomness (32 bytes via
  `crypto.randomBytes`), compared by hash lookup, not by value —
  guessing is infeasible.
- **Cross-tenant impersonation via ID manipulation**: this is the
  headline acceptance criterion ("Unauthorized users cannot read or
  mutate another tenant's records, including by changing IDs in
  requests"). Mitigated structurally by the `forTenant()` Prisma
  extension, not by per-endpoint checks. Verified in
  `apps/api/test/tenant-isolation.e2e-spec.ts` with a direct-ID-lookup
  test across two real tenants.

### Tampering

- **CSRF** (a mutating request riding the victim's ambient session
  cookie): mitigated by the double-submit `CsrfGuard`, applied globally.
  Verified in `csrf.guard.spec.ts` and the e2e suite.
- **Mass-assignment / overposting** (client sending unexpected fields,
  e.g. a `tenantId` or `ownerId` it shouldn't control): mitigated by
  `class-validator`'s `whitelist: true, forbidNonWhitelisted: true` on
  the global `ValidationPipe` — unknown properties are rejected, not
  silently accepted. `tenantId` is also always overwritten server-side by
  the tenant-scope extension regardless of what a DTO might carry.

### Repudiation

- Login, login-failure, logout, and contact-creation events write
  immutable `AuditLog` rows (actor, tenant, action, resource, IP,
  timestamp). *Gap*: not every mutation is audited yet (only what Phase 1
  built); this must expand as Phase 2 adds more write endpoints. Audit
  rows are not currently protected from deletion by a dedicated DB-level
  policy (e.g., no `DELETE`/`UPDATE` grant restriction) — relies on
  application code never issuing those operations. A production
  hardening pass should add a DB-level `REVOKE UPDATE, DELETE` for the
  application role on `audit_logs`.

### Information disclosure

- **Cross-tenant data leakage**: primary Phase 1 concern; see Spoofing
  above — same mitigation applies (it's the same structural guarantee).
- **Error messages**: the global `AllExceptionsFilter` returns the
  `HttpException`'s own message for known exceptions (4xx) but a generic
  "Internal server error" for anything unexpected (5xx), and logs the
  real stack server-side only. Login specifically returns the same
  "Invalid email or password" whether the account doesn't exist or the
  password is wrong, to avoid account enumeration.
- **Password hashes**: never included in any API response DTO (the
  `User` model's `passwordHash` field is never selected into a response;
  `/auth/me` and login responses hand-construct a plain object rather
  than returning the Prisma row directly).
- **Session token**: httpOnly, so not readable by XSS-injected JS in the
  browser (defense in depth alongside the CSP below).

### Denial of service

- Login attempts are rate-limited per key (see Spoofing/Gap above).
  General API-wide rate limiting (e.g., a global request cap per IP) is
  **not** implemented in Phase 1 and should be added (e.g., via a
  reverse proxy or `@nestjs/throttler`) before internet-facing
  production exposure.
- No request body size limits beyond framework defaults were explicitly
  configured; revisit in Phase 5 hardening.

### Elevation of privilege

- RBAC is enforced by `PermissionsGuard`, checking permissions resolved
  from the DB at session-validation time (not cached in the token), so a
  role/permission change takes effect on the user's very next request.
- Every mutating route explicitly declares required permissions via
  `@RequirePermissions(...)`; there is no default-allow path — a new
  endpoint that forgets the guard entirely would be default-*open*,
  though, so **code review must check every new controller method has
  both `SessionAuthGuard` and an explicit permission requirement** (there
  is no automated lint for this yet).

## Defense in depth already in place

- `helmet()` sets standard security headers (CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, HSTS, etc.) on every API response.
- CORS is restricted to `WEB_ORIGIN` with `credentials: true` (not `*`).
- Cookies are `httpOnly` (session) / `SameSite=Lax` (both cookies) /
  `secure` in production (`NODE_ENV=production`).

## Explicitly deferred to later phases (do not assume these are covered)

- Encrypted-at-rest provider credentials (no external providers
  connected yet — Phase 3).
- Webhook signature verification / replay protection (no webhooks exist
  yet — Phase 3).
- File upload / malware scanning (no file upload endpoint exists yet).
- SSRF protections for outbound integration calls (no outbound
  integration calls exist yet).
- MFA enrollment/verification (schema placeholder only — see
  DECISIONS.md #6).
- Distributed rate limiting (see DECISIONS.md #5).
