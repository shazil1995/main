import pg from 'pg';
import type { Config } from './config.js';

// Return NUMERIC/BIGINT as strings (exactness); timestamps stay Date objects.
pg.types.setTypeParser(20, (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v)); // int8 -> number when safe
pg.types.setTypeParser(1700, (v) => v); // numeric -> string

export type Client = pg.PoolClient;

export interface Db {
  /** Row-level-security enforced role. All request traffic uses this. */
  app: pg.Pool;
  /** Owner role: migrations and tests only. Never used for request handling. */
  owner: pg.Pool;
  config: Config;
  close(): Promise<void>;
}

export function createDb(config: Config): Db {
  const app = new pg.Pool({ connectionString: config.APP_DATABASE_URL, max: config.DB_POOL_MAX, idleTimeoutMillis: 30_000, application_name: 'basecraft-app' });
  const owner = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2, idleTimeoutMillis: 10_000, application_name: 'basecraft-owner' });
  app.on('error', () => { /* idle client errors are surfaced on next use */ });
  owner.on('error', () => {});
  return { app, owner, config, async close() { await Promise.all([app.end(), owner.end()]); } };
}

/**
 * Run `fn` in a transaction scoped to one workspace. The workspace id is set with SET LOCAL
 * (set_config(..., true)) so it cannot leak to the next user of this pooled connection.
 */
export async function withWorkspace<T>(db: Db, workspaceId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.workspace_id', $1, true), set_config('statement_timeout', $2, true)`, [workspaceId, String(db.config.STATEMENT_TIMEOUT_MS)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection may be dead */ }
    throw e;
  } finally {
    c.release();
  }
}

/** Transaction on tables that are NOT workspace-scoped (users, sessions, members, tokens). */
export async function withTx<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
