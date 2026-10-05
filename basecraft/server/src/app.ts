import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createDb, type Db } from './db.js';
import { HttpError } from './errors.js';
import { formatZod, makeTraceId, type AppContext } from './http.js';
import { buildOpenApi } from './openapi.js';
import { RateLimiter } from './ratelimit.js';
import { makeReg } from './routes/common.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { schemaRoutes } from './routes/schema.js';
import { recordRoutes } from './routes/records.js';
import { viewRoutes } from './routes/views.js';
import { attachmentRoutes } from './routes/attachments.js';
import { importExportRoutes } from './routes/importExport.js';
import { automationRoutes } from './routes/automations.js';

export const API_VERSION = '0.1.0';

export interface BuiltApp { fastify: FastifyInstance; ctx: AppContext }

export async function buildApp(config: Config, db: Db = createDb(config)): Promise<BuiltApp> {
  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // never log credentials; request bodies are never logged at all
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
    genReqId: (req) => makeTraceId(req as any),
    bodyLimit: 1_048_576,
    trustProxy: process.env.TRUST_PROXY === 'true',
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ctx: AppContext = { db, config, limiter: new RateLimiter(), registry: [] };

  await fastify.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], upgradeInsecureRequests: null, baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await fastify.register(cookie);
  await fastify.register(multipart, { limits: { fileSize: Math.max(config.MAX_ATTACHMENT_BYTES, config.MAX_IMPORT_BYTES), files: 1, fields: 20, fieldSize: 100_000, parts: 30 } });

  fastify.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  fastify.setErrorHandler((err: any, req, reply) => {
    const trace_id = req.id as string;
    const send = (status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) => {
      if (headers) for (const [k, v] of Object.entries(headers)) reply.header(k, v);
      return reply.status(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}), trace_id } });
    };
    if (err instanceof HttpError) return send(err.status, err.code, err.message, err.details, err.headers);
    if (err instanceof ZodError) return send(422, 'validation_failed', 'Invalid request', formatZod(err));
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.code === 'FST_REQ_FILE_TOO_LARGE') return send(413, 'payload_too_large', 'The request body is too large');
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return send(415, 'unsupported_media_type', 'Unsupported content type');
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return send(err.statusCode, 'bad_request', err.message.slice(0, 200));
    if (err.code === '57014') return send(503, 'query_timeout', 'The query took too long. Narrow your filters.');
    if (err.code === '40001' || err.code === '40P01') return send(409, 'retry', 'Concurrent change; please retry');
    if (typeof err.code === 'string' && /^23/.test(err.code)) { req.log.warn({ err }, 'constraint violation'); return send(409, 'constraint_violation', 'The change conflicts with existing data'); }
    req.log.error({ err }, 'unhandled error');
    return send(500, 'internal_error', 'Something went wrong. Quote the trace id when reporting this.');
  });
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint', trace_id: req.id } });
    const index = webIndex();
    const last = req.url.split('?')[0]!.split('/').pop() ?? '';
    // SPA fallback only for route-like paths; a missing asset must be a real 404 (never HTML served as JS/CSS)
    if (index && req.method === 'GET' && !last.includes('.')) return reply.type('text/html').sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found', trace_id: req.id } });
  });

  // health: liveness never touches the database; readiness checks it and the migration state
  fastify.get('/healthz', async () => ({ status: 'ok' }));
  // Warn once at startup when the optional superuser-provisioned fast paths are missing (queries still correct, just slower at scale).
  void db.app.query(`SELECT proleakproof FROM pg_proc WHERE proname = 'bc_jtext' LIMIT 1`).then((r) => {
    if (!r.rows[0]?.proleakproof) fastify.log.warn('LEAKPROOF fast paths are not provisioned (see server/sql/leakproof.sql): filters and search will scan behind row-level security');
  }).catch(() => {});
  fastify.get('/readyz', async (_req, reply) => {
    try {
      const r = await db.app.query(`SELECT 1 FROM bases LIMIT 0`);
      void r;
      const m = await db.app.query(`SELECT 1 FROM users LIMIT 0`);
      void m;
      return { status: 'ready' };
    } catch { return reply.status(503).send({ status: 'not_ready' }); }
  });

  const reg = makeReg(fastify, ctx);
  authRoutes(reg, ctx);
  workspaceRoutes(reg, ctx);
  schemaRoutes(reg, ctx);
  recordRoutes(reg, ctx);
  viewRoutes(reg, ctx);
  attachmentRoutes(reg, ctx);
  importExportRoutes(reg, ctx);
  automationRoutes(reg, ctx);

  let spec: unknown;
  fastify.get('/api/v1/openapi.json', async () => (spec ??= buildOpenApi(ctx.registry, API_VERSION)));

  const dist = webIndex();
  if (dist) await fastify.register(fastifyStatic, { root: dirname(dist), index: 'index.html', maxAge: '1h', setHeaders: (res: any, p: string) => { if (p.endsWith('index.html')) res.header('cache-control', 'no-cache'); } });

  return { fastify, ctx };
}

function webIndex(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, '../../web/dist/index.html'), resolve(process.cwd(), 'web/dist/index.html')]) if (existsSync(p)) return p;
  return null;
}
export { join };
