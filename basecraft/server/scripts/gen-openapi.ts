// Writes docs/openapi.json from the live route registry (single source of truth: the zod schemas on each route).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp, API_VERSION } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildOpenApi } from '../src/openapi.js';

const { fastify, ctx } = await buildApp(loadConfig({ ...process.env, WORKER_MODE: 'off', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv));
const doc = buildOpenApi(ctx.registry, API_VERSION);
const out = resolve(import.meta.dirname, '../../docs/openapi.json');
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(doc.paths as object).length} paths)`);
await fastify.close(); await ctx.db.close();
