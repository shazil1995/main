import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, newApp, signup, tableFixture, wsOf, type Fixture } from './helpers.js';
import { cleanupOrphanAttachments, getStorage } from '../src/routes/attachments.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp, s: Session, fx: Fixture, rec: string;
const P = '/api/v1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n');
beforeAll(async () => { app = await newApp({ MAX_ATTACHMENT_BYTES: '5000' }); s = await signup(app, 'Att'); fx = await tableFixture(s); rec = (await s.post(`${P}/tables/${fx.table}/records`, { fields: { [fx.f.name!]: 'r' } })).body.id; });
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

const up = (filename: string, content: Buffer | string, who: Session = s, field = fx.f.files!, record = rec) =>
  who.upload(`${P}/records/${record}/attachments?field_id=${field}`, [{ name: 'file', filename, content, type: 'application/octet-stream' }]);

describe('attachments', () => {
  it('stores files outside the record JSON, lists them on the record, and serves downloads as attachments only', async () => {
    const r = await up('logo.png', PNG);
    expect(r.status).toBe(201); expect(r.body.content_type).toBe('image/png'); expect(r.body.size).toBe(PNG.length);
    const got = await s.get(`${P}/records/${rec}`);
    expect(got.body.fields[fx.f.files!]).toHaveLength(1);
    expect(got.body.fields[fx.f.files!][0].filename).toBe('logo.png');
    const dbRow = (await app.ctx.db.owner.query(`SELECT "values" FROM records WHERE id=$1`, [rec])).rows[0];
    expect(JSON.stringify(dbRow.values)).not.toContain('logo.png');           // no blob bytes / base64 / names in record JSON
    const dl = await s.call('GET', `${P}/attachments/${r.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(dl.raw.length).toBeGreaterThan(0);
  });

  it('blocks active content, executables, spoofed types and empty files', async () => {
    const cases: [string, Buffer | string, RegExp][] = [
      ['page.html', '<html><script>alert(1)</script></html>', /active content/],
      ['image.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', /active content/],
      ['evil.png', '<!DOCTYPE html><script>alert(1)</script>', /HTML/],           // html disguised as png
      ['evil.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), /Executable/],
      ['tool.exe', Buffer.from('MZ....'), /active content/],
      ['run.sh', '#!/bin/sh\nrm -rf /', /active content/],
      ['noext', '#!/bin/sh\necho', /Scripts|Unsupported/],
      ['photo.jpg', PNG, /do not match/],                                        // png bytes, jpg name
      ['doc.txt', Buffer.concat([Buffer.from('text'), Buffer.from([0]), Buffer.from('more')]), /Binary/],
      ['data.bin', Buffer.from('xyz'), /Unsupported/],
    ];
    for (const [name, content, msg] of cases) {
      const r = await up(name, content);
      expect(r.status, name).toBe(415);
      expect(r.body.error.message, name).toMatch(msg);
    }
    const empty = await up('empty.txt', '');
    expect(empty.status).toBe(422);
    expect((await s.get(`${P}/records/${rec}`)).body.fields[fx.f.files!]).toHaveLength(1);   // nothing leaked in
  });

  it('enforces per-file size, per-cell count and the workspace quota', async () => {
    expect((await up('big.txt', 'a'.repeat(5001))).status).toBe(413);
    const q = await newApp({ MAX_ATTACHMENT_BYTES: '5000' });
    const o = await signup(q, 'Quota'); const f = await tableFixture(o);
    const r = (await o.post(`${P}/tables/${f.table}/records`, { fields: { [f.f.name!]: 'q' } })).body.id;
    await q.ctx.db.owner.query(`UPDATE workspaces SET attachment_quota_bytes = 1000 WHERE id=$1`, [wsOf(o)]);
    expect((await up('a.txt', 'x'.repeat(600), o, f.f.files!, r)).status).toBe(201);
    const over = await up('b.txt', 'x'.repeat(600), o, f.f.files!, r);
    expect(over.status).toBe(413); expect(over.body.error.code).toBe('quota_exceeded');
    expect((await o.get(`${P}/workspaces/${wsOf(o)}`)).body.attachment_bytes_used).toBe(600);
    await q.fastify.close(); await q.ctx.db.close();
    for (let i = 0; i < 19; i++) expect((await up(`n${i}.txt`, 'hello')).status).toBe(201);
    expect((await up('one-too-many.txt', 'hello')).status).toBe(422);
  });

  it('sanitises hostile filenames and rejects non-attachment fields', async () => {
    const t = await tableFixture(s, 'Names'); const r = (await s.post(`${P}/tables/${t.table}/records`, { fields: { [t.f.name!]: 'x' } })).body.id;
    const res = await up('../../etc/pa<script>ss\\wd.txt', 'hello', s, t.f.files!, r);
    expect(res.status).toBe(201);
    expect(res.body.filename).not.toMatch(/[\/\\"<>]/);
    const dl = await s.call('GET', `${P}/attachments/${res.body.id}/download`);
    expect(dl.headers['content-disposition']).not.toMatch(/\.\.|<script>/);
    expect((await up('x.txt', 'hello', s, t.f.name!, r)).status).toBe(422);
    expect((await s.upload(`${P}/records/${r}/attachments?field_id=${t.f.files}`, [{ name: 'other', value: 'x' }])).status).toBe(400);
  });

  it('respects roles and tenant boundaries', async () => {
    const rec2 = (await s.post(`${P}/tables/${fx.table}/records`, { fields: { [fx.f.name!]: 'perm' } })).body.id;
    const r = await up('perm.txt', 'hello', s, fx.f.files!, rec2); const id = r.body.id;
    expect(r.status).toBe(201);
    const outsider = await signup(app, 'Out');
    expect((await outsider.get(`${P}/attachments/${id}/download`)).status).toBe(404);
    expect((await up('x.txt', 'hello', outsider, fx.f.files!, rec2)).status).toBe(404);
    expect((await outsider.del(`${P}/attachments/${id}`)).status).toBe(404);
    const email = `v_${Math.random().toString(16).slice(2, 8)}@example.test`;
    const inv = await s.post(`${P}/workspaces/${wsOf(s)}/invitations`, { email, role: 'viewer' });
    const v = new Session(app, email); const sg = await v.post(`${P}/auth/signup`, { email, name: 'V', password: 'correct horse battery', invite_token: inv.body.token }); v.csrf = sg.body.csrf_token;
    expect((await v.call('GET', `${P}/attachments/${id}/download`)).status).toBe(200);
    expect((await up('x.txt', 'hello', v, fx.f.files!, rec2)).status).toBe(403);
    expect((await v.del(`${P}/attachments/${id}`)).status).toBe(403);
  });

  it('removes blobs of deleted files and records via the orphan cleaner (and never touches live files)', async () => {
    const t = await tableFixture(s, 'Orphans'); const r = (await s.post(`${P}/tables/${t.table}/records`, { fields: { [t.f.name!]: 'x' } })).body;
    const keep = (await up('keep.txt', 'keep me', s, t.f.files!, r.id)).body.id;
    const gone = (await up('gone.txt', 'delete me', s, t.f.files!, r.id)).body.id;
    const keys = (await app.ctx.db.owner.query(`SELECT id, storage_key FROM attachments WHERE id = ANY($1)`, [[keep, gone]])).rows;
    const path = (id: string) => join(app.ctx.config.ATTACHMENT_DIR, keys.find((k) => k.id === id).storage_key);
    expect(existsSync(path(gone))).toBe(true);
    await s.del(`${P}/attachments/${gone}`);
    expect(await cleanupOrphanAttachments(app.ctx, 3600)).toBe(0);              // inside the grace period
    expect(existsSync(path(gone))).toBe(true);
    await cleanupOrphanAttachments(app.ctx, 0);
    expect(existsSync(path(gone))).toBe(false);
    expect(existsSync(path(keep))).toBe(true);
    // deleting the record orphans its files
    expect((await s.del(`${P}/records/${r.id}`, { 'if-match': '"1"' })).status).toBe(204);
    await cleanupOrphanAttachments(app.ctx, 0);
    expect(existsSync(path(keep))).toBe(false);
    expect((await app.ctx.db.owner.query(`SELECT count(*)::int n FROM attachments WHERE id = ANY($1)`, [[keep, gone]])).rows[0].n).toBe(0);
    void getStorage;
  });

  it('is filterable: is_empty / is_not_empty on attachment fields', async () => {
    const t = await tableFixture(s, 'Filterable');
    const a = (await s.post(`${P}/tables/${t.table}/records`, { fields: { [t.f.name!]: 'with' } })).body.id;
    await s.post(`${P}/tables/${t.table}/records`, { fields: { [t.f.name!]: 'without' } });
    await up('f.txt', 'hello', s, t.f.files!, a);
    const has = await s.post(`${P}/tables/${t.table}/records/query`, { filter: { field: t.f.files, op: 'is_not_empty' } });
    expect(has.body.records.map((x: any) => x.id)).toEqual([a]);
    expect((await s.post(`${P}/tables/${t.table}/records/query`, { filter: { field: t.f.files, op: 'is_empty' } })).body.records).toHaveLength(1);
  });
});
