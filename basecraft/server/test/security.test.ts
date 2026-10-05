import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, OWNER_URL, Session, Token, newApp, signup, tableFixture, wsOf, type Fixture } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp;
beforeAll(async () => { app = await newApp(); });
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

const P = '/api/v1';

async function addMember(owner: Session, role: 'viewer' | 'commenter' | 'editor' | 'admin', name = role): Promise<Session> {
  const email = `${role}_${Math.random().toString(16).slice(2, 8)}@example.test`;
  const inv = await owner.post(`${P}/workspaces/${wsOf(owner)}/invitations`, { email, role });
  if (inv.status !== 201) throw new Error('invite failed ' + inv.raw);
  const s = new Session(app, email);
  const r = await s.post(`${P}/auth/signup`, { email, name, password: 'correct horse battery', invite_token: inv.body.token });
  if (r.status !== 201) throw new Error('signup via invite failed ' + r.raw);
  s.csrf = r.body.csrf_token; s.userId = r.body.user.id; (s as any).workspaceId = wsOf(owner);
  return s;
}

describe('tenant isolation', () => {
  let A: Session, B: Session, fa: Fixture, fb: Fixture, recA: string, viewA: string;
  beforeAll(async () => {
    A = await signup(app, 'Alice', 'A Corp'); B = await signup(app, 'Bob', 'B Corp');
    fa = await tableFixture(A); fb = await tableFixture(B);
    recA = (await A.post(`${P}/tables/${fa.table}/records`, { fields: { [fa.f.name!]: 'A secret' } })).body.id;
    await B.post(`${P}/tables/${fb.table}/records`, { fields: { [fb.f.name!]: 'B row' } });
    viewA = (await A.post(`${P}/tables/${fa.table}/views`, { name: 'v', type: 'grid', visibility: 'shared' })).body.id;
  });

  it('B cannot read, count, search, list, export, update or delete A data by guessing ids', async () => {
    const att = '00000000-0000-4000-8000-000000000000';
    const probes: [string, string, unknown?, Record<string, string>?][] = [
      ['GET', `${P}/tables/${fa.table}`], ['GET', `${P}/tables/${fa.table}/fields`], ['GET', `${P}/tables/${fa.table}/records`],
      ['POST', `${P}/tables/${fa.table}/records/query`, { search: 'secret', include_total: true }],
      ['POST', `${P}/tables/${fa.table}/records`, { fields: { [fa.f.name!]: 'x' } }],
      ['POST', `${P}/tables/${fa.table}/records/batch`, { operations: [{ op: 'create', fields: {} }] }],
      ['POST', `${P}/tables/${fa.table}/export`, { format: 'csv' }],
      ['GET', `${P}/records/${recA}`], ['PATCH', `${P}/records/${recA}`, { fields: { [fa.f.name!]: 'pwn' } }, { 'if-match': '"1"' }],
      ['DELETE', `${P}/records/${recA}`, undefined, { 'if-match': '"1"' }], ['GET', `${P}/records/${recA}/comments`],
      ['POST', `${P}/records/${recA}/comments`, { body: 'hi' }],
      ['GET', `${P}/tables/${fa.table}/views`], ['PATCH', `${P}/views/${viewA}`, { name: 'x' }], ['DELETE', `${P}/views/${viewA}`],
      ['GET', `${P}/tables/${fa.table}/automations`], ['GET', `${P}/workspaces/${fa.ws}`], ['GET', `${P}/workspaces/${fa.ws}/members`],
      ['GET', `${P}/workspaces/${fa.ws}/audit`], ['GET', `${P}/workspaces/${fa.ws}/tokens`], ['GET', `${P}/workspaces/${fa.ws}/bases`],
      ['POST', `${P}/workspaces/${fa.ws}/bases`, { name: 'x' }], ['POST', `${P}/bases/${fa.base}/tables`, { name: 'x' }],
      ['GET', `${P}/bases/${fa.base}/tables`], ['PATCH', `${P}/bases/${fa.base}`, { name: 'x' }], ['DELETE', `${P}/tables/${fa.table}`],
      ['POST', `${P}/tables/${fa.table}/fields`, { name: 'x', type: 'text' }], ['PATCH', `${P}/fields/${fa.f.name!}`, { name: 'x' }],
      ['GET', `${P}/attachments/${att}/download`], ['POST', `${P}/workspaces/${fa.ws}/invitations`, { email: 'x@y.co', role: 'viewer' }],
      ['PUT', `${P}/workspaces/${fa.ws}/grants`, { user_id: B.userId, resource_type: 'table', resource_id: fa.table, role: 'admin' }],
    ];
    for (const [m, url, body, h] of probes) {
      const r = await B.call(m, url, body, h);
      expect(r.status, `${m} ${url}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('A secret');
    }
  });

  it('B cannot reference A resources from B own requests', async () => {
    expect((await B.post(`${P}/tables/${fb.table}/records/query`, { view_id: viewA })).status).toBe(404);
    const forged = await B.post(`${P}/tables/${fb.table}/records`, { fields: { [fa.f.name!]: 'x' } });
    expect(forged.status).toBe(422); // A's field id is unknown in B's table
    const owner = await B.post(`${P}/tables/${fb.table}/records`, { fields: {}, workspace_id: fa.ws, table_id: fa.table, created_by: A.userId });
    expect(owner.status).toBe(422); // strict schema: forged ownership keys rejected
    const g = await B.put(`${P}/workspaces/${fb.ws}/grants`, { user_id: A.userId, resource_type: 'table', resource_id: fb.table, role: 'viewer' });
    expect(g.status).toBe(404); // A is not a member of B's workspace
    const tok = await B.post(`${P}/workspaces/${fb.ws}/tokens`, { name: 't', scopes: ['records:read'], table_ids: [fa.table] });
    expect(tok.status).toBe(422);
  });

  it('A data is intact and invisible in B listings', async () => {
    const got = await A.get(`${P}/records/${recA}`);
    expect(got.body.fields[fa.f.name!]).toBe('A secret');
    expect(got.body.version).toBe(1);
    const q = await B.post(`${P}/tables/${fb.table}/records/query`, { search: 'secret', include_total: true });
    expect(q.body.total).toBe(0);
    expect((await B.get(`${P}/auth/me`)).body.workspaces.map((w: any) => w.id)).toEqual([fb.ws]);
  });

  it('a B API token cannot touch A', async () => {
    const t = (await B.post(`${P}/workspaces/${fb.ws}/tokens`, { name: 'b', scopes: ['records:read', 'records:write', 'schema:read'] })).body.token;
    const tk = new Token(app, t);
    expect((await tk.call('GET', `${P}/tables/${fa.table}/records`)).status).toBe(404);
    expect((await tk.call('GET', `${P}/records/${recA}`)).status).toBe(404);
    expect((await tk.call('GET', `${P}/tables/${fb.table}/records`)).status).toBe(200);
  });

  describe('database row-level security (defense in depth)', () => {
    const mkPool = () => new pg.Pool({ connectionString: APP_URL, max: 1 });

    it('without a workspace context the app role sees nothing', async () => {
      const pool = mkPool();
      for (const t of ['records', 'fields', 'tables', 'bases', 'views', 'audit_events', 'outbox_events', 'automations', 'attachments']) {
        expect((await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
      await pool.end();
    });
    it('with workspace B context only B rows are visible; cross-tenant writes are refused', async () => {
      const pool = mkPool();
      const c = await pool.connect();
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [fb.ws]);
      const seen = await c.query(`SELECT DISTINCT workspace_id FROM records`);
      expect(seen.rows.map((r) => r.workspace_id)).toEqual([fb.ws].filter(() => seen.rowCount! > 0));
      expect((await c.query(`SELECT count(*)::int n FROM records WHERE id=$1`, [recA])).rows[0].n).toBe(0);
      await expect(c.query(`INSERT INTO records (workspace_id, base_id, table_id) VALUES ($1,$2,$3)`, [fa.ws, fa.base, fa.table])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // UPDATE/DELETE against A rows silently affect nothing
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [fb.ws]);
      expect((await c.query(`UPDATE records SET version = 99 WHERE id=$1`, [recA])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM records WHERE id=$1`, [recA])).rowCount).toBe(0);
      await c.query('ROLLBACK'); c.release(); await pool.end();
    });
    it('workspace context cannot leak to the next user of a pooled connection', async () => {
      const pool = mkPool(); // one connection => guaranteed reuse
      for (let i = 0; i < 20; i++) {
        const c = await pool.connect();
        await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [i % 2 ? fa.ws : fb.ws]);
        expect((await c.query(`SELECT count(*)::int n FROM records`)).rows[0].n).toBeGreaterThan(0);
        await c.query('COMMIT'); c.release();
        const d = await pool.connect();
        expect((await d.query(`SELECT count(*)::int n FROM records`)).rows[0].n).toBe(0);
        expect((await d.query(`SELECT current_setting('app.workspace_id', true) AS w`)).rows[0].w).toBeFalsy();
        d.release();
      }
      await pool.end();
    });
    it('composite foreign keys stop even a privileged writer from mixing tenants', async () => {
      const o = new pg.Client({ connectionString: OWNER_URL }); await o.connect();
      await expect(o.query(`INSERT INTO records (workspace_id, base_id, table_id) VALUES ($1,$2,$3)`, [fb.ws, fa.base, fa.table])).rejects.toThrow(/foreign key/);
      await expect(o.query(`INSERT INTO fields (workspace_id, table_id, name, type) VALUES ($1,$2,'x','text')`, [fb.ws, fa.table])).rejects.toThrow(/foreign key/);
      await o.end();
    });
    it('the app role cannot rewrite or delete audit history', async () => {
      const pool = mkPool();
      await expect(pool.query(`UPDATE audit_events SET action='x'`)).rejects.toThrow(/permission denied/);
      await expect(pool.query(`DELETE FROM audit_events`)).rejects.toThrow(/permission denied/);
      await pool.end();
      const o = new pg.Client({ connectionString: OWNER_URL }); await o.connect();
      await expect(o.query(`UPDATE audit_events SET action='x'`)).rejects.toThrow(/append-only/);
      await expect(o.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
      await o.end();
    });
  });
});

describe('roles and the permission matrix', () => {
  let owner: Session, fx: Fixture, viewer: Session, commenter: Session, editor: Session, admin: Session, rec: string;
  beforeAll(async () => {
    owner = await signup(app, 'Olive'); fx = await tableFixture(owner);
    [viewer, commenter, editor, admin] = [await addMember(owner, 'viewer'), await addMember(owner, 'commenter'), await addMember(owner, 'editor'), await addMember(owner, 'admin')];
    rec = (await owner.post(`${P}/tables/${fx.table}/records`, { fields: { [fx.f.name!]: 'row' } })).body.id;
  });
  const fields = (v = 'x') => ({ fields: { [fx.f.name!]: v } });

  it('viewer can read but not mutate or export', async () => {
    expect((await viewer.get(`${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await viewer.get(`${P}/records/${rec}`)).status).toBe(200);
    expect((await viewer.post(`${P}/tables/${fx.table}/records`, fields())).status).toBe(403);
    expect((await viewer.patch(`${P}/records/${rec}`, fields('z'), { 'if-match': '"1"' })).status).toBe(403);
    expect((await viewer.del(`${P}/records/${rec}`, { 'if-match': '"1"' })).status).toBe(403);
    expect((await viewer.post(`${P}/tables/${fx.table}/records/batch`, { operations: [{ op: 'create', fields: {} }] })).status).toBe(403);
    expect((await viewer.post(`${P}/tables/${fx.table}/export`, { format: 'csv' })).status).toBe(403);
    expect((await viewer.post(`${P}/records/${rec}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await viewer.post(`${P}/tables/${fx.table}/fields`, { name: 'n', type: 'text' })).status).toBe(403);
    expect((await viewer.post(`${P}/workspaces/${fx.ws}/bases`, { name: 'n' })).status).toBe(403);
    expect((await viewer.get(`${P}/workspaces/${fx.ws}/members`)).status).toBe(403);
    expect((await viewer.get(`${P}/workspaces/${fx.ws}/audit`)).status).toBe(403);
    expect((await viewer.post(`${P}/workspaces/${fx.ws}/tokens`, { name: 't', scopes: ['records:read'] })).status).toBe(403);
    // viewers may keep personal views, not shared ones
    expect((await viewer.post(`${P}/tables/${fx.table}/views`, { name: 'mine', type: 'grid', visibility: 'personal' })).status).toBe(201);
    expect((await viewer.post(`${P}/tables/${fx.table}/views`, { name: 'shared', type: 'grid', visibility: 'shared' })).status).toBe(403);
  });
  it('commenter can comment but still cannot edit', async () => {
    expect((await commenter.post(`${P}/records/${rec}/comments`, { body: 'looks good' })).status).toBe(201);
    expect((await commenter.get(`${P}/records/${rec}/comments`)).body.comments).toHaveLength(1);
    expect((await commenter.patch(`${P}/records/${rec}`, fields('z'), { 'if-match': '"1"' })).status).toBe(403);
    expect((await commenter.post(`${P}/tables/${fx.table}/records`, fields())).status).toBe(403);
  });
  it('editor edits data and shared views but not schema, automations, members or tokens', async () => {
    expect((await editor.post(`${P}/tables/${fx.table}/records`, fields('e'))).status).toBe(201);
    expect((await editor.patch(`${P}/records/${rec}`, fields('e2'), { 'if-match': '"1"' })).status).toBe(200);
    expect((await editor.post(`${P}/tables/${fx.table}/export`, { format: 'csv' })).status).toBe(200);
    expect((await editor.post(`${P}/tables/${fx.table}/views`, { name: 'sh', type: 'grid', visibility: 'shared' })).status).toBe(201);
    expect((await editor.post(`${P}/tables/${fx.table}/views`, { name: 'lk', type: 'grid', visibility: 'locked' })).status).toBe(403);
    expect((await editor.post(`${P}/tables/${fx.table}/fields`, { name: 'n', type: 'text' })).status).toBe(403);
    expect((await editor.post(`${P}/tables/${fx.table}/automations`, { name: 'a', trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: {} }] })).status).toBe(403);
    expect((await editor.get(`${P}/workspaces/${fx.ws}/members`)).status).toBe(403);
    expect((await editor.post(`${P}/workspaces/${fx.ws}/tokens`, { name: 't', scopes: ['records:read'] })).status).toBe(403);
    expect((await editor.del(`${P}/tables/${fx.table}`)).status).toBe(403);
  });
  it('admin manages schema, automations, tokens, audit and lower roles but cannot touch owners or grant admin', async () => {
    expect((await admin.post(`${P}/tables/${fx.table}/fields`, { name: 'adminfield', type: 'text' })).status).toBe(201);
    expect((await admin.post(`${P}/tables/${fx.table}/views`, { name: 'lk', type: 'grid', visibility: 'locked' })).status).toBe(201);
    expect((await admin.get(`${P}/workspaces/${fx.ws}/audit`)).status).toBe(200);
    expect((await admin.get(`${P}/workspaces/${fx.ws}/members`)).status).toBe(200);
    expect((await admin.post(`${P}/workspaces/${fx.ws}/invitations`, { email: 'n@example.test', role: 'editor' })).status).toBe(201);
    expect((await admin.post(`${P}/workspaces/${fx.ws}/invitations`, { email: 'n2@example.test', role: 'admin' })).status).toBe(403);
    expect((await admin.patch(`${P}/workspaces/${fx.ws}/members/${owner.userId}`, { role: 'viewer' })).status).toBe(403);
    expect((await admin.patch(`${P}/workspaces/${fx.ws}/members/${viewer.userId}`, { role: 'admin' })).status).toBe(403);
    expect((await admin.patch(`${P}/workspaces/${fx.ws}/members/${viewer.userId}`, { role: 'commenter' })).status).toBe(200);
    expect((await admin.patch(`${P}/workspaces`, {})).status).toBe(404);
    expect((await admin.patch(`${P}/workspaces/${fx.ws}`, { name: 'renamed' })).status).toBe(403); // owner only
    expect((await owner.patch(`${P}/workspaces/${fx.ws}`, { name: 'renamed' })).status).toBe(200);
    await owner.patch(`${P}/workspaces/${fx.ws}/members/${viewer.userId}`, { role: 'viewer' });
  });
  it('the last owner cannot be demoted or removed', async () => {
    expect((await owner.patch(`${P}/workspaces/${fx.ws}/members/${owner.userId}`, { role: 'admin' })).status).toBe(409);
    expect((await owner.del(`${P}/workspaces/${fx.ws}/members/${owner.userId}`)).status).toBe(409);
  });
  it('removing a member cuts access immediately', async () => {
    const tmp = await addMember(owner, 'editor');
    expect((await tmp.get(`${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await owner.del(`${P}/workspaces/${fx.ws}/members/${tmp.userId}`)).status).toBe(204);
    expect((await tmp.get(`${P}/tables/${fx.table}/records`)).status).toBe(404);
  });

  describe('base/table grants', () => {
    it('"none" hides a table; a higher table role elevates a viewer for that table only', async () => {
      const second = (await owner.post(`${P}/bases/${fx.base}/tables`, { name: 'Private' })).body.id;
      const v = await addMember(owner, 'viewer');
      expect((await v.get(`${P}/tables/${second}/records`)).status).toBe(200);
      expect((await owner.put(`${P}/workspaces/${fx.ws}/grants`, { user_id: v.userId, resource_type: 'table', resource_id: second, role: 'none' })).status).toBe(200);
      expect((await v.get(`${P}/tables/${second}/records`)).status).toBe(404);
      expect((await v.get(`${P}/bases/${fx.base}/tables`)).body.tables.map((t: any) => t.id)).not.toContain(second);
      expect((await owner.put(`${P}/workspaces/${fx.ws}/grants`, { user_id: v.userId, resource_type: 'table', resource_id: fx.table, role: 'editor' })).status).toBe(200);
      expect((await v.post(`${P}/tables/${fx.table}/records`, fields('elevated'))).status).toBe(201);
      expect((await v.post(`${P}/tables/${fx.table}/fields`, { name: 'zz', type: 'text' })).status).toBe(403);
      expect((await owner.put(`${P}/workspaces/${fx.ws}/grants`, { user_id: v.userId, resource_type: 'table', resource_id: fx.table, role: null })).status).toBe(200);
      expect((await v.post(`${P}/tables/${fx.table}/records`, fields('x'))).status).toBe(403);
    });
  });

  describe('invitations', () => {
    it('are single-use, expire, can be revoked, and bind to the invited email', async () => {
      const email = `inv_${Math.random().toString(16).slice(2, 8)}@example.test`;
      const mk = async () => (await owner.post(`${P}/workspaces/${fx.ws}/invitations`, { email, role: 'viewer' })).body;
      const body = (token: string, em = email) => ({ email: em, name: 'N', password: 'correct horse battery', invite_token: token });
      const anon = () => new Session(app);
      const a = await mk();
      expect((await anon().post(`${P}/auth/signup`, body(a.token, 'other@example.test'))).status).toBe(403); // wrong email
      expect((await anon().post(`${P}/auth/signup`, body(a.token))).status).toBe(201);
      expect((await anon().post(`${P}/auth/signup`, body(a.token))).status).toBe(403); // used
      const b = await mk();
      await owner.del(`${P}/invitations/${b.id}`);
      expect((await anon().post(`${P}/auth/signup`, body(b.token, email))).status).toBe(403); // revoked
      const c = await mk();
      await app.ctx.db.owner.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [c.id]);
      expect((await anon().post(`${P}/auth/signup`, body(c.token, email))).status).toBe(403); // expired
      const rows = await app.ctx.db.owner.query(`SELECT token_hash FROM invitations WHERE id=$1`, [a.id]);
      expect(rows.rows[0].token_hash.length).toBe(32); // only a hash is stored
    });
    it('self-service signup can be disabled', async () => {
      const closed = await newApp({ ALLOW_SIGNUP: 'false' });
      const r = await new Session(closed).post(`${P}/auth/signup`, { email: 'x@example.test', name: 'X', password: 'correct horse battery' });
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('signup_disabled');
      await closed.fastify.close(); await closed.ctx.db.close();
    });
  });
});

describe('API tokens', () => {
  let owner: Session, fx: Fixture, other: string;
  beforeAll(async () => { owner = await signup(app, 'Tok'); fx = await tableFixture(owner); other = (await owner.post(`${P}/bases/${fx.base}/tables`, { name: 'Other' })).body.id; });
  const mint = async (body: Record<string, unknown>) => { const r = await owner.post(`${P}/workspaces/${fx.ws}/tokens`, { name: 't', ...body }); expect(r.status).toBe(201); return { id: r.body.id as string, tk: new Token(app, r.body.token as string), raw: r.body.token as string }; };

  it('are high-entropy, shown once, and stored only as a hash', async () => {
    const { id, raw } = await mint({ scopes: ['records:read'] });
    expect(raw.length).toBeGreaterThan(40);
    const row = (await app.ctx.db.owner.query(`SELECT token_hash, token_prefix FROM api_tokens WHERE id=$1`, [id])).rows[0];
    expect(row.token_hash.length).toBe(32);
    expect(raw.startsWith(row.token_prefix)).toBe(true);
    const all = JSON.stringify((await app.ctx.db.owner.query(`SELECT * FROM api_tokens`)).rows);
    expect(all).not.toContain(raw);
    const listed = await owner.get(`${P}/workspaces/${fx.ws}/tokens`);
    expect(JSON.stringify(listed.body)).not.toContain(raw);
  });
  it('enforce scopes', async () => {
    const ro = (await mint({ scopes: ['records:read', 'schema:read'] })).tk;
    expect((await ro.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await ro.call('GET', `${P}/tables/${fx.table}`)).status).toBe(200);
    expect((await ro.call('POST', `${P}/tables/${fx.table}/records`, { fields: {} })).status).toBe(403);
    expect((await ro.call('POST', `${P}/tables/${fx.table}/export`, { format: 'csv' })).status).toBe(403);
    const rw = (await mint({ scopes: ['records:read', 'records:write'] })).tk;
    const c = await rw.call('POST', `${P}/tables/${fx.table}/records`, { fields: { [fx.f.name!]: 'via token' } });
    expect(c.status).toBe(201);
    expect((await rw.call('PATCH', `${P}/records/${c.body.id}`, { fields: { [fx.f.name!]: 'v2' } }, { 'if-match': '"1"' })).status).toBe(200);
    expect((await rw.call('DELETE', `${P}/records/${c.body.id}`, undefined, { 'if-match': '"2"' })).status).toBe(403); // no records:delete scope
    expect((await rw.call('GET', `${P}/tables/${fx.table}`)).status).toBe(403); // no schema:read
  });
  it('can never administer members, tokens, audit, automations or schema, even with every scope', async () => {
    const all = (await mint({ scopes: ['schema:read', 'records:read', 'records:write', 'records:delete', 'views:read', 'attachments:read', 'attachments:write'] })).tk;
    const attempts: [string, string, unknown?][] = [
      ['GET', `${P}/workspaces/${fx.ws}/members`], ['POST', `${P}/workspaces/${fx.ws}/invitations`, { email: 'a@b.co', role: 'viewer' }],
      ['POST', `${P}/workspaces/${fx.ws}/tokens`, { name: 'x', scopes: ['records:read'] }], ['GET', `${P}/workspaces/${fx.ws}/tokens`], ['GET', `${P}/workspaces/${fx.ws}/audit`],
      ['PUT', `${P}/workspaces/${fx.ws}/grants`, {}], ['PATCH', `${P}/workspaces/${fx.ws}`, { name: 'x' }], ['POST', `${P}/auth/logout`], ['POST', `${P}/workspaces`, { name: 'x' }],
      ['POST', `${P}/workspaces/${fx.ws}/bases`, { name: 'x' }], ['POST', `${P}/bases/${fx.base}/tables`, { name: 'x' }], ['POST', `${P}/tables/${fx.table}/fields`, { name: 'x', type: 'text' }],
      ['GET', `${P}/tables/${fx.table}/automations`], ['POST', `${P}/tables/${fx.table}/views`, { name: 'x', type: 'grid' }],
    ];
    for (const [m, u, b] of attempts) { const r = await all.call(m, u, b); expect([403, 404], `${m} ${u} -> ${r.status}`).toContain(r.status); expect(r.status).not.toBe(200); expect(r.status).not.toBe(201); }
  });
  it('can be restricted to specific tables', async () => {
    const t = (await mint({ scopes: ['records:read'], table_ids: [fx.table] })).tk;
    expect((await t.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await t.call('GET', `${P}/tables/${other}/records`)).status).toBe(404);
  });
  it('revoked, expired and rotated tokens stop working', async () => {
    const rev = await mint({ scopes: ['records:read'] });
    expect((await rev.tk.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await owner.del(`${P}/tokens/${rev.id}`)).status).toBe(204);
    const r = await rev.tk.call('GET', `${P}/tables/${fx.table}/records`);
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('invalid_token');

    const exp = await mint({ scopes: ['records:read'], expires_in_days: 1 });
    await app.ctx.db.owner.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id=$1`, [exp.id]);
    expect((await exp.tk.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(401);

    const old = await mint({ scopes: ['records:read'] });
    const rot = await owner.post(`${P}/tokens/${old.id}/rotate`);
    expect(rot.status).toBe(201);
    expect((await old.tk.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(401);
    expect((await new Token(app, rot.body.token).call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(200);
    expect((await new Token(app, 'bc_' + 'A'.repeat(43)).call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(401);
    expect((await new Token(app, 'nope').call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(401);
  });
  it('stop working when their creator loses access', async () => {
    const adm = await addMember(owner, 'admin');
    const tk = new Token(app, (await adm.post(`${P}/workspaces/${fx.ws}/tokens`, { name: 'adm', scopes: ['records:read'] })).body.token);
    expect((await tk.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(200);
    await owner.del(`${P}/workspaces/${fx.ws}/members/${adm.userId}`);
    expect((await tk.call('GET', `${P}/tables/${fx.table}/records`)).status).toBe(404);
  });
  it('are rate limited with Retry-After', async () => {
    const limited = await newApp({ RATE_LIMIT_TOKEN_PER_MIN: '5' });
    const o = await signup(limited, 'RL'); const f = await tableFixture(o);
    const t = new Token(limited, (await o.post(`${P}/workspaces/${f.ws}/tokens`, { name: 'x', scopes: ['records:read'] })).body.token);
    const codes: number[] = []; let last: any;
    for (let i = 0; i < 8; i++) { last = await t.call('GET', `${P}/tables/${f.table}/records`); codes.push(last.status); }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect(last.body.error.code).toBe('rate_limited');
    await limited.fastify.close(); await limited.ctx.db.close();
  });
});

describe('sessions, CSRF and login hardening', () => {
  it('rejects mutating browser requests without a valid CSRF token or from a foreign origin', async () => {
    const s = await signup(app, 'Csrf'); const ws = wsOf(s);
    expect((await s.call('POST', `${P}/workspaces/${ws}/bases`, { name: 'x' }, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await s.call('POST', `${P}/workspaces/${ws}/bases`, { name: 'x' }, { 'x-csrf-token': 'wrong' })).body.error.code).toBe('csrf_failed');
    expect((await s.call('POST', `${P}/workspaces/${ws}/bases`, { name: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.call('POST', `${P}/workspaces/${ws}/bases`, { name: 'x' }, { origin: 'null' })).status).toBe(403);
    expect((await s.call('POST', `${P}/workspaces/${ws}/bases`, { name: 'ok' }, { origin: 'http://localhost:5173' })).status).toBe(201);
    expect((await s.get(`${P}/workspaces/${ws}/bases`)).status).toBe(200); // reads need no CSRF header
  });
  it('sets HttpOnly SameSite cookies and revokes the session on logout', async () => {
    const s = new Session(app); const email = `c_${Math.random().toString(16).slice(2, 8)}@example.test`;
    const r = await s.call('POST', `${P}/auth/signup`, { email, name: 'C', password: 'correct horse battery' });
    const setc = ([] as string[]).concat(r.headers['set-cookie'] as any);
    const sess = setc.find((c) => c.startsWith('bc_session='))!;
    expect(sess).toMatch(/HttpOnly/i); expect(sess).toMatch(/SameSite=Lax/i);
    expect(setc.find((c) => c.startsWith('bc_csrf='))).not.toMatch(/HttpOnly/i);
    s.csrf = r.body.csrf_token;
    const old = new Map(s.cookies);
    expect((await s.get(`${P}/auth/me`)).status).toBe(200);
    expect((await s.post(`${P}/auth/logout`)).status).toBe(204);
    s.cookies = old; // replay the stolen cookie
    expect((await s.get(`${P}/auth/me`)).status).toBe(401);
    expect((await new Session(app).get(`${P}/auth/me`)).status).toBe(401);
    const bogus = new Session(app); bogus.cookies.set('bc_session', 'garbage');
    expect((await bogus.get(`${P}/auth/me`)).status).toBe(401);
  });
  it('does not reveal whether an email exists and throttles repeated failures', async () => {
    const t = await newApp({ LOGIN_MAX_FAILURES: '4' });
    const u = await signup(t, 'Thr');
    const a = await new Session(t).post(`${P}/auth/login`, { email: u.email, password: 'wrong password!!' });
    const b = await new Session(t).post(`${P}/auth/login`, { email: 'nobody@example.test', password: 'wrong password!!' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    let last: any;
    for (let i = 0; i < 6; i++) last = await new Session(t).post(`${P}/auth/login`, { email: u.email, password: 'wrong password!!' });
    expect(last.status).toBe(429); expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect((await new Session(t).post(`${P}/auth/login`, { email: u.email, password: 'correct horse battery' })).status).toBe(429);
    await t.fastify.close(); await t.ctx.db.close();
  });
  it('stores only argon2id hashes, enforces password strength, and change-password revokes other sessions', async () => {
    const s = await signup(app, 'Pw');
    const hash = (await app.ctx.db.owner.query(`SELECT password_hash FROM users WHERE id=$1`, [s.userId])).rows[0].password_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect((await new Session(app).post(`${P}/auth/signup`, { email: 'weak@example.test', name: 'W', password: 'short' })).status).toBe(422);
    const second = new Session(app, s.email);
    const l = await second.post(`${P}/auth/login`, { email: s.email, password: 'correct horse battery' });
    second.csrf = l.body.csrf_token;
    expect((await second.get(`${P}/auth/me`)).status).toBe(200);
    expect((await s.post(`${P}/auth/change-password`, { current_password: 'wrong', new_password: 'another long password' })).status).toBe(401);
    const ch = await s.post(`${P}/auth/change-password`, { current_password: 'correct horse battery', new_password: 'another long password' });
    expect(ch.status).toBe(200);
    expect((await second.get(`${P}/auth/me`)).status).toBe(401);
    expect((await new Session(app).post(`${P}/auth/login`, { email: s.email, password: 'another long password' })).status).toBe(200);
  });
  it('returns a uniform error envelope with a trace id and honours x-request-id', async () => {
    const r = await new Session(app).get(`${P}/tables/${'0'.repeat(8)}-0000-4000-8000-000000000000/records`, { 'x-request-id': 'trace-abc-12345' });
    expect(r.status).toBe(401); expect(r.body.error.trace_id).toBe('trace-abc-12345'); expect(r.headers['x-request-id']).toBe('trace-abc-12345');
    const bad = await new Session(app).call('POST', `${P}/auth/login`, '{not json', { 'content-type': 'application/json' });
    expect(bad.status).toBe(400); expect(bad.body.error.trace_id).toBeTruthy();
    const nf = await new Session(app).get(`${P}/nope`);
    expect(nf.status).toBe(404); expect(nf.body.error.code).toBe('not_found');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

describe('audit trail', () => {
  it('records membership, schema, record and credential changes with the actor', async () => {
    const o = await signup(app, 'Aud'); const fx = await tableFixture(o);
    const rec = (await o.post(`${P}/tables/${fx.table}/records`, { fields: { [fx.f.name!]: 'x' } })).body;
    await o.patch(`${P}/records/${rec.id}`, { fields: { [fx.f.name!]: 'y' } }, { 'if-match': '"1"' });
    await o.del(`${P}/records/${rec.id}`, { 'if-match': '"2"' });
    const m = await addMember(o, 'editor');
    await o.patch(`${P}/workspaces/${fx.ws}/members/${m.userId}`, { role: 'viewer' });
    const tok = (await o.post(`${P}/workspaces/${fx.ws}/tokens`, { name: 'k', scopes: ['records:read'] })).body;
    await o.del(`${P}/tokens/${tok.id}`);
    const log = (await o.get(`${P}/workspaces/${fx.ws}/audit?limit=200`)).body.events;
    const actions = new Set(log.map((e: any) => e.action));
    for (const a of ['table.create', 'record.create', 'record.update', 'record.delete', 'invitation.create', 'member.role_change', 'token.create', 'token.revoke']) expect(actions, a).toContain(a);
    expect(log.every((e: any) => e.actor_type === 'user')).toBe(true);
    expect(JSON.stringify(log)).not.toContain(tok.token);
  });
});
