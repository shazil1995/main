import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load a local .env if present (never committed). Real env vars always win.
for (const p of ['.env', '../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } break; }
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().default(def);

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  PORT: int(4100),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_ORIGIN: z.string().default('http://localhost:5173'),
  SERVER_SECRET: z.string().min(32, 'SERVER_SECRET must be at least 32 characters'),
  ALLOW_SIGNUP: bool.default(true),
  WORKER_MODE: z.enum(['inline', 'separate', 'off']).default('inline'),
  WORKER_CONCURRENCY: int(2),
  ATTACHMENT_DIR: z.string().default('./data/attachments'),
  IMPORT_DIR: z.string().default('./data/imports'),
  MAX_ATTACHMENT_BYTES: int(10 * 1024 * 1024),
  MAX_EXPORT_ROWS: int(1_000_000),
  MAX_IMPORT_ROWS: int(200_000),
  MAX_IMPORT_BYTES: int(50 * 1024 * 1024),
  IMPORT_BATCH_ROWS: int(500),
  DB_POOL_MAX: int(10),
  STATEMENT_TIMEOUT_MS: int(15_000),
  SESSION_TTL_HOURS: int(24 * 7),
  RATE_LIMIT_TOKEN_PER_MIN: int(600),
  RATE_LIMIT_WORKSPACE_PER_MIN: int(3000),
  RATE_LIMIT_ANON_PER_MIN: int(120),
  LOGIN_MAX_FAILURES: int(8),
  AUTOMATION_MAX_DEPTH: int(3),
  AUTOMATION_MAX_ATTEMPTS: int(4),
  AUDIT_RETENTION_DAYS: int(365),
  OUTBOX_RETENTION_DAYS: int(7),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}
