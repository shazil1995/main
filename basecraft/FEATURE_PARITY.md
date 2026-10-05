# Basecraft feature parity register

**Register date:** 2026-10-05 · **Build:** Phase 1 (v0.1.0)

**Reference edition.** The requirements come from `BUILD_BRIEF` (Basecraft prompt dated 2026-10-03). The Airtable support
pages listed in the brief **could not be fetched from the build sandbox** (egress to `support.airtable.com` is blocked), so
this register has **not** been checked against current Airtable documentation. Airtable-derived rows are marked
`unverified-reference` and must be reviewed against the live docs before any parity claim is made. Nothing here claims
Airtable API compatibility, and "parity" below always means *feature-family coverage*, never behavioral/API compatibility.

**Status vocabulary** (a button or a stub is never "implemented"):

| status | meaning |
|---|---|
| `verified` | implemented AND covered by an automated test or measurement named in the evidence column |
| `implemented` | code exists and was exercised (e.g. in the browser run) but has no dedicated automated test |
| `partial` | works with documented gaps |
| `planned` | not built; scheduled for the listed phase |
| `blocked` | cannot proceed without a decision/credential/account |

Evidence names refer to `server/test/*.test.ts` (API + Postgres integration), `web/src/**/*.test.ts` (unit),
`web/e2e/smoke.mjs` (Chromium end-to-end) and `bench/raw/` (load-test output).

## Phase 1 — accounts, data, views, permissions, automations, API

| capability | reference/date | intended behavior | phase | status | verification evidence | known limitations |
|---|---|---|---|---|---|---|
| Sign-up / sign-in / sign-out | brief 2026-10-03 | argon2id passwords, server-side sessions, HttpOnly SameSite=Lax cookie, revocable | 1 | verified | `security.test` "sessions, CSRF and login hardening" | Own implementation (no external auth library); no MFA, no SSO, no password reset email (no mail sending by design) |
| CSRF + origin checks | brief | double-submit token + Origin check on state-changing browser requests | 1 | verified | `security.test` CSRF test | — |
| Login throttling | brief | per-IP+email and per-email failure lockout with Retry-After | 1 | verified | `security.test` throttle test | In-memory, single-process (not shared across instances) |
| MFA | brief (relevant phase) | TOTP/WebAuthn | 2+ | planned | — | Not implemented |
| Workspaces, bases, tables | brief | hierarchy with stable UUIDs, soft delete | 1 | verified | `crud.test` schema, `security.test` | Delete is soft with no UI to restore (operator-only); no trash UI |
| Field types: text, long text, integer, decimal, currency (ISO code), percent, date, datetime (tz), checkbox, single/multi select, email, URL, phone, created/modified time | brief | strict validation; false ≠ 0 ≠ empty; decimals as exact strings; DST-safe datetimes | 1 | verified | `fieldTypes.test`, `crud.test` | Phone is format-validated only (no libphonenumber/country rules); field **type cannot change** after creation |
| Attachment field | brief | files in private storage, metadata in DB, never in record JSON | 1 | verified | `attachments.test` | Local-disk adapter only; no S3 adapter yet (interface exists) |
| Schema evolution | brief | rename never changes id; type change with preview + recoverable originals | 1 | partial | `crud.test` (rename/soft-delete/select options) | **Type change not implemented** (preview/convert planned); select-option removal blocked while in use |
| Record CRUD + detail panel | brief | create/read/patch/delete, side panel, comments | 1 | verified | `crud.test`, e2e "record panel" | — |
| Optimistic concurrency | brief | If-Match/version; 412 with current record; conflict UI | 1 | verified | `crud.test` (incl. 8-way race), e2e | UI offers "re-apply my change", not a field-level merge |
| Idempotent creates | brief | Idempotency-Key, body fingerprint, 24 h retention | 1 | verified | `crud.test` idempotency (incl. concurrent duplicates) | Only on create endpoints (records, batch, form submit) |
| Grid view | brief | keyboard nav, inline edit, focus preservation, paste validation, bulk select, undo | 1 | partial | `gridNav.test`; e2e (nav, edit, invalid, undo, panel) | Undo covers cell edits/paste only (not deletes). Cell range selection is not implemented (single active cell + row selection). Long text / multi-select edit via the record panel. Sticky first column not implemented |
| Grid virtualization (rows + columns) | brief | bounded DOM, bounded cached pages | 1 | verified | e2e "renders a window of rows" | Browser memory for 100k rows **not yet profiled** (see PERFORMANCE.md) |
| Kanban, gallery, basic calendar, form views | brief | all use the same record source | 1 | implemented | `calendarMath.test`, `boardMath.test`; e2e opens each view; form submit in e2e | Built by delegated workers; only pure logic has unit tests. Gallery shows filename placeholders — **no image previews** (active-content policy). Calendar is month-only |
| Saved views: search, filter groups, sort, group, hide/order/width | brief | server-side, personal/shared/locked | 1 | verified | `crud.test` views, `security.test` role matrix | Group-by renders headers by loaded rows (no per-group counts); row colors/summary bars not built |
| Personal / shared / locked view permissions | brief | owner / editor / admin | 1 | verified | `security.test` | — |
| Server-side filter / sort / cursor pagination | brief | keyset cursors, tie-breaks, bounded pages, selectable fields | 1 | verified | `crud.test` (duplicates, nulls, asc/desc, backwards walk) | Count is capped at 100,000. No random-access scrolling (cursor only) |
| Search | brief | substring search over text + select names | 1 | verified | `crud.test` search; bench `search-trigram` | pg_trgm over a denormalised text column; no stemming/ranking |
| CSV import | brief | mapping, preview, conversions, validation report, duplicate policy, batch-atomic, resumable | 1 | verified | `importexport.test` (incl. crash+resume) | CSV only (no XLSX); select options are not auto-created; resume re-validates from the start |
| CSV/JSON export (full selection) | brief | streamed, formula-injection-safe, current-page labelled separately | 1 | verified | `importexport.test` export suite | Streamed synchronously (no background job/`202` for very large exports); cap `MAX_EXPORT_ROWS` |
| Attachments policy | brief | size/quota/type sniffing/active content blocked/orphan cleanup | 1 | verified | `attachments.test` | Scanner is a no-op port (no ClamAV); "quarantine" status modelled but unused |
| Roles: owner/admin/editor/commenter/viewer | brief | documented matrix | 1 | verified | `security.test` role matrix; matrix in `docs/SECURITY.md` | — |
| Base/table role overrides (grants) | brief | hide or elevate per base/table | 1 | verified | `security.test` grants | Per-**field** and per-**row** policies are **unavailable** (Phase 2) |
| Invitations | brief | expiring, revocable, single-use, no silent email | 1 | verified | `security.test` invitations | Link is shown to the admin; no email |
| Audit trail | brief | append-only for membership/schema/record/automation/credential events | 1 | verified | `security.test` audit + DB immutability | No export UI/API; retention purge function exists, no schedule UI |
| Automation triggers | brief | record created/updated, condition matched, form submitted, manual test | 1 | verified | `automation.test` | — |
| Automation actions | brief | validated create/update record; outgoing HTTP/email only with credentials+approval+safety | 1 | partial | `automation.test` | **No outgoing HTTP or email actions** (needs credential store, approval flow, SSRF controls) — rejected at validation |
| Automation test mode & run history | brief | preview without side effects; actual status/attempts/timing, redacted inputs | 1 | verified | `automation.test` | — |
| Durable events / retries / dead letter / loop caps | brief (Phase 3 items pulled forward in part) | outbox, leases, backoff, DLQ, depth + loop guard | 1 | verified | `automation.test` durability + safety | At-least-once; ordering not guaranteed with concurrency > 1; events are only written for tables that have enabled automations |
| Versioned REST API + OpenAPI | brief | `/api/v1`, `docs/openapi.json` generated from route schemas | 1 | verified | `openapi.test` | Response bodies are mostly undocumented schema-wise (descriptions only) |
| API tokens | brief | hashed, high-entropy, scoped, expiring, revocable, rotatable | 1 | verified | `security.test` API tokens | Scopes are record/schema-read oriented; tokens can never administer anything |
| Rate limits, trace ids, error envelope | brief | per-token/workspace limits, Retry-After, trace id | 1 | verified | `security.test` | In-memory buckets (single process) |
| Webhook endpoints (outgoing) | brief ("as implemented") | signed webhooks | 3 | planned | — | Not implemented |
| Client examples (TS, Python) | brief | minimal working examples | 1 | implemented | `docs/examples/` run against the live API in this session | Not part of CI |
| Tenant isolation | brief | app checks + Postgres RLS + composite FKs | 1 | verified | `security.test` isolation + RLS suites | App role is non-owner/no BYPASSRLS; owner role used for migrations/tests only |
| Backup & restore | brief | tested restore into a clean DB | 1 | verified | `bench/raw/restore-test.txt` (106k records: backup 2.0 s, restore 7.1 s) | Logical backups only; no PITR; blob files backed up separately; restore needs a superuser (see `docs/BACKUP_RESTORE.md`) |
| Index-friendly queries behind RLS | brief (performance) | filters/search/sorts use indexes while RLS stays enforced | 1 | partial | `fastpaths.test`, `PERFORMANCE.md` (search 783→67 ms, indexed filter 492→71 ms, indexed sort 4037→71 ms p95) | Needs a one-time **superuser** provisioning step (`server/sql/leakproof.sql`); without it all features work but are slower. Un-indexed filters/sorts miss the 250 ms target; numeric range, ILIKE and multi-select filters never use indexes |

## Phase 2 — depth and collaboration (planned)

| capability | status | notes |
|---|---|---|
| Linked records, lookups, rollups, formulas (AST interpreter, no eval), dependency tracking | planned | Design in `docs/architecture.md`; link edges are relational, formulas interpreted with execution limits |
| List/timeline/Gantt views, richer calendar/kanban, record colors, summaries, print layouts | planned | |
| Form conditional logic, public forms with anti-abuse | planned | Public forms deliberately **not** shipped: current forms require sign-in |
| Comments with mentions, notifications, revisions/snapshots/restore, trash | partial | Plain-text comments exist; others planned |
| Row/field access policies (counts/sort/filter/export leak tests) | planned | **Unavailable** — only workspace/base/table roles exist |
| Realtime collaboration/presence (SSE/WebSocket) | planned | |
| Interface builder / dashboards | planned | |
| Table/base duplication, templates, Excel import, Airtable import tool | planned | |

## Phase 3 — durable automation and CRM connections (planned, nothing connected)

| capability | status | notes |
|---|---|---|
| Schedules/cron, delays, branches, loops, webhooks triggers | planned | |
| Outgoing HTTP actions with SSRF protection, signed webhooks | planned | Requires secret store + egress proxy decision |
| Custom CRM connector (REST + signed webhooks, mappings, idempotent upserts) | planned | |
| HubSpot connector | blocked | needs sandbox account + verified current auth/quota docs (docs unreachable from build sandbox) → `unverified` |
| Salesforce connector | blocked | needs sandbox org + verified External Client App/OAuth route → `unverified` |
| Encrypted credential storage, refresh locking | planned | |

## Phase 4 — parity expansion (planned)

AI-assisted features (opt-in, budgeted), SSO/SAML/OIDC, SCIM, audit export, governance/retention UI, scripting/extensions
sandbox, mobile/localization, sandboxes/release management. All `planned`; none started. Each needs a reference-edition
review against current Airtable docs (`unverified-reference`).
