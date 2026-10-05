import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp;
beforeAll(async () => { app = await newApp(); });
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

describe('OpenAPI contract', () => {
  it('documents every registered route with auth and error responses', async () => {
    const r = await app.fastify.inject({ url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toBe('3.1.0');
    const ops = Object.entries(doc.paths).flatMap(([p, o]: any) => Object.entries(o).map(([m, op]: any) => ({ p, m, op })));
    expect(ops.length).toBe(app.ctx.registry.length);
    expect(ops.length).toBeGreaterThan(60);
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { p, m, op } of ops) {
      expect(op.summary, `${m} ${p}`).toBeTruthy();
      expect(op.responses['429'] ?? op.responses['404'], `${m} ${p}`).toBeTruthy();
      for (const name of p.match(/\{(\w+)\}/g) ?? []) expect(op.parameters.some((x: any) => `{${x.name}}` === name && x.in === 'path'), `${m} ${p} ${name}`).toBe(true);
    }
    const create = doc.paths['/api/v1/tables/{tableId}/records'].post;
    expect(create.parameters.some((x: any) => x.name === 'Idempotency-Key')).toBe(true);
    expect(create.security).toEqual([{ bearer: [] }, { session: [] }]);
    expect(doc.paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/workspaces/{workspaceId}/members'].get.security).toEqual([{ session: [] }]); // tokens cannot use it
  });
  it('serves health and readiness probes without authentication', async () => {
    expect((await app.fastify.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.fastify.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready' });
  });
});
