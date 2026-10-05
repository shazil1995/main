import { z, type ZodType } from 'zod';
import type { RouteDoc } from './http.js';

function schemaOf(s: ZodType): Record<string, unknown> {
  try {
    const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;
    delete j.$schema;
    return j;
  } catch { return {}; }
}

const ErrorEnvelope = {
  type: 'object', required: ['error'],
  properties: { error: { type: 'object', required: ['code', 'message', 'trace_id'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, trace_id: { type: 'string' } } } },
};

export function buildOpenApi(docs: RouteDoc[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...docs].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  for (const d of sorted) {
    const path = d.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters: unknown[] = [];
    if (d.params) {
      const js = schemaOf(d.params) as any;
      for (const [name, sch] of Object.entries(js.properties ?? {})) parameters.push({ name, in: 'path', required: true, schema: sch });
    }
    if (d.query) {
      const js = schemaOf(d.query) as any;
      const req = new Set<string>(js.required ?? []);
      for (const [name, sch] of Object.entries(js.properties ?? {})) parameters.push({ name, in: 'query', required: req.has(name), schema: sch });
    }
    if (d.method !== 'GET' && d.permission && d.params === undefined) { /* no-op */ }
    if (d.idempotent) parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Makes retries of this create safe for 24 hours; reusing a key with a different body returns 422.' });
    if (path.includes('/records/{recordId}') && ['PATCH', 'DELETE'].includes(d.method)) parameters.push({ name: 'If-Match', in: 'header', required: false, schema: { type: 'string' }, description: 'Record version as an ETag, e.g. "3". Mismatch returns 412 with the current record. Required unless the version is supplied in the body/query.' });
    const responses: Record<string, unknown> = {};
    for (const [code, v] of Object.entries(d.responses)) {
      responses[code] = typeof v === 'string' ? { description: v } : { description: 'OK', content: { 'application/json': { schema: schemaOf(v) } } };
    }
    for (const code of [400, 401, 403, 404, 422, 429]) {
      if (code === 401 && d.auth === 'public') continue;
      responses[String(code)] ??= { description: { 400: 'Bad request', 401: 'Not authenticated', 403: 'Not permitted', 404: 'Not found', 422: 'Validation failed', 429: 'Rate limited (see Retry-After)' }[code], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
    }
    const op: Record<string, unknown> = {
      summary: d.summary, tags: [d.tag], operationId: opId(d), parameters,
      security: d.auth === 'public' ? [] : d.auth === 'session' ? [{ session: [] }] : [{ bearer: [] }, { session: [] }],
      responses,
      ...(d.permission ? { 'x-required-permission': d.permission } : {}),
    };
    if (d.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(d.body) } } };
    if (d.multipart) op.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object' } } } };
    (paths[path] ??= {})[d.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Basecraft API', version,
      description: 'Versioned REST API. NOT a drop-in Airtable API: identifiers are stable field IDs, updates are partial merges with optimistic versions, and pagination is cursor-based. See docs/MIGRATION.md.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'API token ("bc_…"). Scoped to a workspace and optional bases/tables; can never administer members, tokens, automations or schema.' },
        session: { type: 'apiKey', in: 'cookie', name: 'bc_session', description: 'Browser session. State-changing requests also need the X-CSRF-Token header.' },
      },
      schemas: { Error: ErrorEnvelope },
    },
    paths,
  };
}

function opId(d: RouteDoc): string {
  const parts = d.path.replace(/^\/api\/v1\//, '').split('/').filter(Boolean).map((p) => (p.startsWith(':') ? 'By' + p.slice(1).replace(/Id$/, '') : p));
  return d.method.toLowerCase() + parts.map((p) => p.replace(/[^A-Za-z0-9]/g, ' ').replace(/(^| )(\w)/g, (_, __, c) => c.toUpperCase()).replace(/ /g, '')).join('');
}
