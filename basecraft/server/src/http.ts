import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import type { Permission } from '@basecraft/shared';
import { audit as writeAudit } from './audit.js';
import { authenticate, withTx } from './auth.js';
import { resolveAccess } from './authz.js';
import type { Config } from './config.js';
import { canonicalJson, safeEqual, sha256 } from './crypto.js';
import { withWorkspace, type Client, type Db } from './db.js';
import { HttpError, forbidden, notFound, unprocessable } from './errors.js';
import { RateLimiter } from './ratelimit.js';
import { actorOf, principalId, type Access, type Principal } from './types.js';
import type { BlobStore, Scanner } from './storage.js';

export class HttpReply {
  constructor(public status: number, public body?: unknown, public headers: Record<string, string> = {}) {}
}
export const created = (body: unknown, headers?: Record<string, string>) => new HttpReply(201, body, headers);
export const accepted = (body: unknown) => new HttpReply(202, body);
export const noContent = () => new HttpReply(204);
export const withHeaders = (body: unknown, headers: Record<string, string>) => new HttpReply(200, body, headers);

export type Resource = 'workspace' | 'base' | 'table' | 'field' | 'record' | 'view' | 'attachment' | 'automation' | 'import_job' | 'token' | 'invitation';

export interface AppContext {
  db: Db; config: Config; limiter: RateLimiter; registry: RouteDoc[];
  /** Test seams only (e.g. simulate a crash between import batches). Never set in production code paths. */
  /** Blob storage + scanner, created lazily from config (local disk in dev; swap for S3 adapter). */
  storage?: { store: BlobStore; scanner: Scanner };
  hooks?: { afterImportBatch?: (rowsCommitted: number) => Promise<void> | void };
}

export interface Ctx<P = any, Q = any, B = any> {
  app: AppContext;
  req: FastifyRequest;
  reply: FastifyReply;
  params: P; query: Q; body: B;
  principal: Principal | null;
  access: Access | null;
  /** Workspace transaction (RLS context set). Null for public routes and `tx:false` routes. */
  c: Client | null;
  traceId: string;
  /** Throws 403 unless the principal holds `p` on this scope. */
  require(p: Permission): void;
  /** Run `fn` after the workspace transaction has COMMITTED (e.g. CREATE INDEX CONCURRENTLY). Failures are logged, not thrown. */
  onCommit(fn: () => Promise<void>): void;
  audit(action: string, target?: { type: string; id?: string | null }, metadata?: Record<string, unknown>): Promise<void>;
}

export interface RouteDoc {
  method: string; path: string; summary: string; tag: string; auth: 'public' | 'session' | 'any';
  params?: ZodType; query?: ZodType; body?: ZodType; multipart?: boolean;
  responses: Record<number, ZodType | string>;
  permission?: Permission; idempotent?: boolean;
}

export interface RouteSpec<P extends ZodType | undefined, Q extends ZodType | undefined, B extends ZodType | undefined> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  tag: string;
  /** public: no auth. session: browser session only. any: session cookie or bearer token. */
  auth: 'public' | 'session' | 'any';
  params?: P; query?: Q; body?: B;
  multipart?: boolean;
  bodyLimit?: number;
  responses?: Record<number, ZodType | string>;
  scope?: { resource: Resource; param: string; permission: Permission; tx?: boolean };
  idempotent?: boolean;
  /** Skip the rate limiter (health checks). */
  noRateLimit?: boolean;
  handler: (ctx: Ctx<P extends ZodType ? z.infer<P> : any, Q extends ZodType ? z.infer<Q> : any, B extends ZodType ? z.infer<B> : any>) => Promise<unknown>;
}

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatZod(e: z.ZodError) {
  return e.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function parse<T>(schema: ZodType | undefined, value: unknown, what: string, status = 422): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(status, 'validation_failed', `Invalid ${what}`, formatZod(r.error));
  return r.data as T;
}

function checkOrigin(app: AppContext, req: FastifyRequest) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') { if (origin === 'null') throw forbidden('Cross-origin request blocked'); return; }
  let host: string;
  try { host = new URL(origin).host; } catch { throw forbidden('Cross-origin request blocked'); }
  if (origin === app.config.PUBLIC_ORIGIN || host === req.headers.host) return;
  throw forbidden('Cross-origin request blocked');
}

export function registerRoute<P extends ZodType | undefined, Q extends ZodType | undefined, B extends ZodType | undefined>(
  fastify: FastifyInstance, app: AppContext, spec: RouteSpec<P, Q, B>,
) {
  app.registry.push({
    method: spec.method, path: spec.path, summary: spec.summary, tag: spec.tag, auth: spec.auth,
    params: spec.params, query: spec.query, body: spec.body, multipart: spec.multipart,
    responses: spec.responses ?? { 200: 'OK' }, permission: spec.scope?.permission, idempotent: spec.idempotent,
  });

  fastify.route({
    method: spec.method,
    url: spec.path,
    bodyLimit: spec.bodyLimit,
    handler: async (req, reply) => {
      const traceId = req.id as string;
      let rlHeaders: Record<string, string> = {};

      // 1. authentication
      let principal: Principal | null = null;
      if (spec.auth !== 'public') {
        principal = await authenticate(app.db, req);
        if (!principal) throw new HttpError(401, 'unauthorized', 'Authentication required');
        if (spec.auth === 'session' && principal.type !== 'user') {
          throw new HttpError(403, 'token_not_allowed', 'API tokens cannot use this endpoint');
        }
      } else {
        principal = await authenticate(app.db, req).catch(() => null);
      }

      // 2. rate limits (per token / user, per workspace, per IP when anonymous)
      if (!spec.noRateLimit) {
        const c = app.config;
        if (!principal) rlHeaders = app.limiter.take(`ip:${req.ip}`, c.RATE_LIMIT_ANON_PER_MIN);
        else if (principal.type === 'token') {
          rlHeaders = app.limiter.take(`tok:${principal.tokenId}`, c.RATE_LIMIT_TOKEN_PER_MIN);
          app.limiter.take(`ws:${principal.workspaceId}`, c.RATE_LIMIT_WORKSPACE_PER_MIN);
        } else rlHeaders = app.limiter.take(`usr:${principal.userId}`, c.RATE_LIMIT_TOKEN_PER_MIN * 2);
      }

      // 3. CSRF / origin for state-changing requests
      const unsafe = UNSAFE.has(spec.method);
      if (unsafe) {
        checkOrigin(app, req);
        if (principal?.type === 'user' && spec.auth !== 'public') {
          const h = req.headers['x-csrf-token'];
          if (typeof h !== 'string' || !safeEqual(h, principal.csrf)) throw new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token');
        }
      }

      // 4. params (a malformed id is simply "not found")
      let params: any = {};
      try { params = parse(spec.params, req.params, 'path parameters'); } catch { throw notFound(); }

      const afterCommit: (() => Promise<void>)[] = [];
      const mk = (c: Client | null, access: Access | null): Ctx => ({
        app, req, reply, params, query: undefined, body: undefined, principal, access, c, traceId,
        onCommit(fn) { afterCommit.push(fn); },
        require(p) { if (!access) throw forbidden(); if (!access.has(p)) throw forbidden(`Missing permission: ${p}`); },
        async audit(action, target, metadata) {
          if (!c || !access) throw new Error('audit requires a workspace scope');
          await writeAudit(c, { workspaceId: access.workspaceId, actor: actorOf(principal), action, targetType: target?.type, targetId: target?.id ?? null, metadata, ip: req.ip, traceId });
        },
      });

      const finish = async (ctx: Ctx) => {
        ctx.query = parse(spec.query, req.query, 'query string', 400);
        if (spec.body) {
          if (req.body === undefined) throw new HttpError(400, 'body_required', 'Request body is required');
          ctx.body = parse(spec.body, req.body, 'request body');
        }
        let out: unknown;
        if (spec.idempotent && principal && ctx.c && ctx.access) {
          out = await runIdempotent(ctx, () => spec.handler(ctx as any));
        } else out = await spec.handler(ctx as any);
        return out;
      };

      let out: unknown;
      if (!spec.scope) {
        out = await finish(mk(null, null));
      } else {
        const sc = spec.scope;
        const id = params[sc.param] as string;
        if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound();
        let ws: string, baseId: string | null = null, tableId: string | null = null;
        if (sc.resource === 'workspace') ws = id;
        else {
          const r = await app.db.app.query('SELECT * FROM bc_resolve($1, $2)', [sc.resource, id]);
          const row = r.rows[0];
          if (!row) throw notFound();
          ws = row.workspace_id; baseId = row.base_id; tableId = row.table_id;
          if (sc.resource === 'base') baseId = id;
          if (sc.resource === 'table') tableId = id;
        }
        const run = async (c: Client) => {
          const access = await resolveAccess(c, principal!, { workspaceId: ws, baseId, tableId });
          if (!access) throw notFound();
          if (!access.has(sc.permission)) throw forbidden(`Missing permission: ${sc.permission}`);
          const ctx = mk(sc.tx === false ? null : c, access);
          return finish(ctx);
        };
        out = await withWorkspace(app.db, ws, run);
        for (const fn of afterCommit) await fn().catch((err) => req.log.error({ err }, 'post-commit hook failed'));
      }

      for (const [k, v] of Object.entries(rlHeaders)) reply.header(k, v);
      if (out instanceof HttpReply) {
        for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
        reply.status(out.status);
        return out.status === 204 ? reply.send() : reply.send(out.body);
      }
      if (reply.sent) return reply;
      return reply.send(out ?? { ok: true });
    },
  });
}

/**
 * Idempotency-Key support. The key row is written in the SAME transaction as the business effect: either both commit or
 * neither does. A concurrent duplicate blocks on the unique key until the first commits, then replays its stored response.
 */
async function runIdempotent(ctx: Ctx, fn: () => Promise<unknown>): Promise<unknown> {
  const raw = ctx.req.headers['idempotency-key'];
  if (raw === undefined) return fn();
  const key = Array.isArray(raw) ? raw[0]! : raw;
  if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 1-200 printable ASCII characters');
  const c = ctx.c!, ws = ctx.access!.workspaceId, pid = principalId(ctx.principal!);
  const fp = sha256(`${ctx.req.method} ${ctx.req.routeOptions.url}\n${ctx.req.url}\n${canonicalJson(ctx.req.body ?? null)}`);
  const ins = await c.query(
    `INSERT INTO idempotency_keys (workspace_id, principal_id, key, fingerprint, status, expires_at)
     VALUES ($1,$2,$3,$4,'in_progress', now() + interval '24 hours') ON CONFLICT DO NOTHING RETURNING key`,
    [ws, pid, key, fp],
  );
  if (ins.rowCount === 0) {
    const ex = (await c.query(`SELECT fingerprint, status, response_status, response_body FROM idempotency_keys WHERE workspace_id=$1 AND principal_id=$2 AND key=$3`, [ws, pid, key])).rows[0];
    if (!ex) throw new HttpError(409, 'idempotency_conflict', 'Retry the request');
    if (!Buffer.from(ex.fingerprint).equals(fp)) throw unprocessable('This Idempotency-Key was already used with a different request', undefined, 'idempotency_key_reuse');
    if (ex.status !== 'done') throw new HttpError(409, 'idempotency_in_progress', 'A request with this key is still being processed');
    return new HttpReply(ex.response_status, ex.response_body, { 'idempotent-replay': 'true' });
  }
  const out = await fn();
  const rep = out instanceof HttpReply ? out : new HttpReply(200, out);
  await c.query(`UPDATE idempotency_keys SET status='done', response_status=$4, response_body=$5 WHERE workspace_id=$1 AND principal_id=$2 AND key=$3`,
    [ws, pid, key, rep.status, JSON.stringify(rep.body ?? null)]);
  return rep;
}

export function makeTraceId(req: { headers: Record<string, unknown> }): string {
  const h = req.headers['x-request-id'];
  return typeof h === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(h) ? h : randomUUID();
}

export { withTx };
