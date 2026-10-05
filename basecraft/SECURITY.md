# Basecraft security notes (Phase 1)

This describes controls that exist **and are tested** in this repository, and what is explicitly missing. Passing these checks
does not make the system "secure" or compliant with SOC 2, GDPR, HIPAA or any other regime; no certification is claimed.

## Threat model (summary)

| asset / threat | control | evidence | gap |
|---|---|---|---|
| Cross-tenant read/write (guessed IDs, forged owner fields) | route-level authz returning 404; strict body schemas; Postgres RLS on all content tables with per-transaction `set_config(..., true)`; composite FKs; non-owner app role | `security.test` "tenant isolation" (31 endpoint probes, RLS suite incl. pool-reuse leak test, FK test) | RLS policies are not `FORCE`d: the **owner** role bypasses RLS, so never use it for request traffic (the app doesn't) |
| Session theft / fixation | opaque 256-bit token, only SHA-256 stored, `HttpOnly; SameSite=Lax` (+`Secure` when `PUBLIC_ORIGIN` is https), 7-day expiry, server-side revocation on logout/password change | `security.test` sessions | No device list/“sign out everywhere” UI; no idle timeout |
| CSRF | double-submit token header for cookie-authenticated state changes + Origin allow-check (same host or `PUBLIC_ORIGIN`; `Origin: null` rejected) | `security.test` | — |
| Credential stuffing | argon2id; uniform login error + dummy hash for unknown emails; per-IP+email and per-email lockout | `security.test` | In-memory counters (per process). MFA not implemented |
| API token abuse | 256-bit random token, SHA-256 at rest, shown once, scopes ∩ creator's permissions, optional table/base allow-list, expiry, revoke, rotate; tokens die when the creator loses access; tokens **cannot** reach members/tokens/audit/automations/schema endpoints | `security.test` "API tokens" | No IP allow-list; rate limits are in-memory |
| Injection | zod strict schemas; all values parameterised; field ids inlined only after matching the table's real UUID field list; `LIKE` metacharacters escaped; operators allow-listed | `crud.test` (SQL-looking filter value, `%`/`_` search) | — |
| Malicious uploads | detected-type policy (magic bytes + extension), HTML/SVG/XML/script/exe blocked, size/quota/cell-count limits, filename sanitising, `attachment`+`nosniff`+`CSP sandbox` on download, no inline previews | `attachments.test` | **No malware scanner** (port exists); EXIF/zip-bomb inspection not done |
| Malicious CSV (import) | streamed parsing with record-size cap, row cap, byte cap, whole-file validation before any write | `importexport.test` | Quote/formula text is stored as data; exports neutralise it |
| Formula injection via export | text-like cells starting with `= + - @ TAB CR` are prefixed with `'`; numeric fields untouched; headers too | `importexport.test` | Users who re-import an exported file get the `'` back (documented) |
| Automation abuse / runaway loops | per-chain loop guard, depth cap, bounded attempts + backoff, dead letter, no outbound network actions | `automation.test` | No per-workspace execution budget yet |
| Audit tampering | `audit_events`: app role has INSERT/SELECT only; trigger forbids UPDATE/DELETE even for the owner (only `bc_cleanup` retention purge may delete) | `security.test` | Not hash-chained; DB superusers can still tamper |
| Secrets in logs | Pino redacts `Authorization`, cookies, CSRF header; request bodies are never logged; tokens never stored in clear | log review + `security.test` (token not in list/audit) | — |
| Clickjacking / XSS | helmet CSP (`default-src 'self'`, `frame-ancestors 'none'`, no inline scripts), React text rendering only (no `dangerouslySetInnerHTML`) | e2e: no console errors; header assertions in `security.test` | `style-src-attr 'unsafe-inline'` is allowed for virtualised row positioning |
| CORS | none enabled (same-origin SPA; tokens are for server-to-server use) | — | Browser apps on other origins are unsupported by design |

## Permission matrix (server-enforced)

| capability | viewer | commenter | editor | admin | owner |
|---|:-:|:-:|:-:|:-:|:-:|
| read records, schema, views, attachments, comments | ✓ | ✓ | ✓ | ✓ | ✓ |
| personal views | ✓ | ✓ | ✓ | ✓ | ✓ |
| comment | | ✓ | ✓ | ✓ | ✓ |
| create/edit/delete records, upload files, submit forms | | | ✓ | ✓ | ✓ |
| import, export, shared views, read automations | | | ✓ | ✓ | ✓ |
| schema (bases/tables/fields), locked views, automations (write), tokens, invitations/members (below own role), audit log | | | | ✓ | ✓ |
| rename/delete workspace | | | | | ✓ |

Base/table **grants** can raise a member's role on one table or set `none` to hide it. Field-level and row-level policies are
**not available** (Phase 2) — do not rely on this build to hide individual columns or rows from a user who can open the table.
Admins cannot assign roles ≥ their own and cannot touch owners; a workspace always keeps ≥ 1 owner.

## Superuser-provisioned helpers (read before running `server/sql/leakproof.sql`)

`bc_jtext` and `bc_textlike` are aliases of stock Postgres functions that a superuser marks `LEAKPROOF` so index conditions work behind
row-level security. Marking a function leakproof is a **security assertion** to the planner: it promises the function cannot reveal
argument values through errors or side channels. `jsonb_object_field_text` never raises on jsonb input. `textlike` can raise only on a
malformed pattern (a trailing escape), which depends on the pattern — always generated and escaped by Basecraft — not on stored data.
If you are not comfortable with that argument, skip the script: everything works without it, only slower at scale.

## Deployment checklist (before exposing to a network)

1. `ALLOW_SIGNUP=false` and onboard via invitations; set `PUBLIC_ORIGIN` to the real https origin and terminate TLS in front.
2. Set `SERVER_SECRET` (≥ 32 random bytes) and unique DB passwords via a secret manager; never commit `.env`.
3. Run behind a reverse proxy and set `TRUST_PROXY=true` only if it strips client-supplied `X-Forwarded-*`.
4. Use the non-owner `basecraft_app` DSN for `APP_DATABASE_URL`; keep `DATABASE_URL` (owner) out of the API container if you run migrations separately.
5. Put a malware scanner behind the `Scanner` port before allowing untrusted uploads; move blobs to private object storage.
6. Run more than one instance only after moving rate limits/login throttles to shared storage.
7. Schedule `pg_dump` + blob backups and **rehearse the restore** (`docs/BACKUP_RESTORE.md`).
8. Dependency audit: `npm audit` is clean for the shipped dependency set as of 2026-10-05 (run it again before release).

## Reporting

No public disclosure process is defined for this build; add a security contact before publishing.
