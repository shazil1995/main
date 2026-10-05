import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies pending SQL migrations as the OWNER role, under an advisory lock. Migrations are never run by request handling. */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await c.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name as string, r.checksum as string]));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Migration ${f} was modified after being applied`);
        continue;
      }
      log(`applying ${f}`);
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)', [f, sum]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      applied.push(f);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await c.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  migrate(cfg.DATABASE_URL).then((a) => { console.log(a.length ? `applied ${a.length} migration(s)` : 'up to date'); }).catch((e) => { console.error(e.message); process.exit(1); });
}
