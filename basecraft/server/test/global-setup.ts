// Tests run against a dedicated database so dev data is never touched.
import { migrate } from '../src/migrate.js';
import pg from 'pg';

export default async function setup() {
  const base = process.env.TEST_DATABASE_URL ?? 'postgres://basecraft_owner:dev_owner_pw@localhost:5432/basecraft_test';
  process.env.TEST_DATABASE_URL = base;
  await migrate(base, () => {});
  // wipe all data between runs (owner bypasses RLS; audit trigger needs the purge flag)
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  await c.query(`SELECT set_config('basecraft.audit_purge','on',false)`);
  await c.query(`TRUNCATE users, workspaces RESTART IDENTITY CASCADE`);
  await c.query(`DELETE FROM audit_events`);
  await c.end();
}
