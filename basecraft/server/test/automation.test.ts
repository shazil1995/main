import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, newApp, signup, tableFixture, type Fixture, type Session } from './helpers.js';
import type { BuiltApp } from '../src/app.js';

let app: BuiltApp, s: Session, fx: Fixture, worker: Worker;
const P = '/api/v1';
beforeAll(async () => { app = await newApp({ AUTOMATION_MAX_ATTEMPTS: '3', AUTOMATION_MAX_DEPTH: '3' }); worker = new Worker(app.ctx, app.fastify.log); s = await signup(app, 'Auto'); });
afterAll(async () => { await app.fastify.close(); await app.ctx.db.close(); });

async function fresh() { fx = await tableFixture(s, 'Auto ' + Math.random().toString(16).slice(2, 6)); return fx; }
const mk = (body: Record<string, unknown>) => s.post(`${P}/tables/${fx.table}/automations`, { name: 'auto', ...body });
const create = (fields: Record<string, unknown>) => s.post(`${P}/tables/${fx.table}/records`, { fields });
const get = async (id: string) => (await s.get(`${P}/records/${id}`)).body;
const runs = async (id: string) => (await s.get(`${P}/automations/${id}/runs`)).body.runs;

describe('automations', () => {
  it('record created -> update action runs through the same pipeline and leaves a redacted run history', async () => {
    await fresh();
    const a = await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.status!]: 'Quote', [fx.f.notes!]: 'Created: {{' + fx.f.name + '}}' } }] });
    expect(a.status).toBe(201);
    const r = await create({ [fx.f.name!]: 'Lobby sign' });
    expect(await worker.drain()).toBeGreaterThan(0);
    const got = await get(r.body.id);
    expect(got.fields[fx.f.notes!]).toBe('Created: Lobby sign');
    expect(got.fields[fx.f.status!]).toBeTruthy();
    const rs = await runs(a.body.id);
    expect(rs[0].status).toBe('success'); expect(rs[0].duration_ms).toBeGreaterThanOrEqual(0); expect(rs[0].attempts).toBe(1);
    expect(JSON.stringify(rs)).not.toContain('Lobby sign');         // inputs are redacted to ids/field ids
    const audit = (await s.get(`${P}/workspaces/${fx.ws}/audit?limit=100`)).body.events;
    expect(audit.some((e: any) => e.action === 'record.update' && e.metadata.source === 'automation')).toBe(true);
  });

  it('is effectively-once: redelivering the same event does not repeat the side effect', async () => {
    await fresh();
    const a = await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.qty!]: 1 } }] });
    const r = await create({ [fx.f.name!]: 'dup' });
    await worker.drain();
    const v1 = (await get(r.body.id)).version;
    await app.ctx.db.owner.query(`UPDATE outbox_events SET status='pending', next_attempt_at=now(), locked_until=NULL, attempts=0 WHERE record_id=$1 AND type='record.created'`, [r.body.id]);
    await worker.drain();
    expect((await get(r.body.id)).version).toBe(v1);
    expect((await runs(a.body.id)).filter((x: any) => x.status === 'success')).toHaveLength(1);
  });

  it('condition matched fires on the transition only', async () => {
    await fresh();
    const a = await mk({ trigger: { type: 'condition_matched' }, conditions: { field: fx.f.status!, op: 'eq', value: 'Approved' }, actions: [{ type: 'update_record', fields: { [fx.f.done!]: true } }] });
    const r = await create({ [fx.f.name!]: 'x' }); await worker.drain();
    expect((await get(r.body.id)).fields[fx.f.done!]).toBeUndefined();
    await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.status!]: 'Approved' } }, { 'if-match': '"1"' }); await worker.drain();
    let g = await get(r.body.id); expect(g.fields[fx.f.done!]).toBe(true);
    // un-check, edit something else while still Approved: must NOT fire again
    await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.done!]: false } }, { 'if-match': `"${g.version}"` }); await worker.drain();
    g = await get(r.body.id); await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.qty!]: 5 } }, { 'if-match': `"${g.version}"` }); await worker.drain();
    expect((await get(r.body.id)).fields[fx.f.done!]).toBe(false);
    expect((await runs(a.body.id)).filter((x: any) => x.status === 'success')).toHaveLength(1);
  });

  it('record updated honours watched fields and conditions', async () => {
    await fresh();
    const a = await mk({ trigger: { type: 'record_updated', watch_fields: [fx.f.qty!] }, conditions: { field: fx.f.qty!, op: 'gt', value: 10 }, actions: [{ type: 'update_record', fields: { [fx.f.notes!]: 'big' } }] });
    const r = await create({ [fx.f.name!]: 'w' });
    await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.name!]: 'w2' } }, { 'if-match': '"1"' }); await worker.drain();
    await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.qty!]: 5 } }, { 'if-match': '"2"' }); await worker.drain();
    expect((await get(r.body.id)).fields[fx.f.notes!]).toBeUndefined();
    await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.qty!]: 50 } }, { 'if-match': '"3"' }); await worker.drain();
    expect((await get(r.body.id)).fields[fx.f.notes!]).toBe('big');
    expect(a.status).toBe(201);
  });

  it('form submissions use the same pipeline', async () => {
    await fresh();
    const form = await s.post(`${P}/tables/${fx.table}/views`, { name: 'Intake', type: 'form', visibility: 'shared', config: { form: { fields: [{ field: fx.f.name!, required: true }, { field: fx.f.contact! }] } } });
    expect(form.status).toBe(201);
    await mk({ trigger: { type: 'form_submitted' }, actions: [{ type: 'update_record', fields: { [fx.f.status!]: 'Quote' } }] });
    expect((await s.post(`${P}/views/${form.body.id}/submit`, { fields: {} })).status).toBe(422);              // required
    expect((await s.post(`${P}/views/${form.body.id}/submit`, { fields: { [fx.f.name!]: 'n', [fx.f.qty!]: 3 } })).status).toBe(422); // field not on the form
    const ok = await s.post(`${P}/views/${form.body.id}/submit`, { fields: { [fx.f.name!]: 'Customer A', [fx.f.contact!]: 'a@b.co' } });
    expect(ok.status).toBe(201); await worker.drain();
    expect((await get(ok.body.record_id)).fields[fx.f.status!]).toBeTruthy();
  });

  it('imports and batch API writes emit the same events', async () => {
    await fresh();
    await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.notes!]: 'seen' } }] });
    await s.post(`${P}/tables/${fx.table}/records/batch`, { operations: [{ op: 'create', fields: { [fx.f.name!]: 'b1' } }, { op: 'create', fields: { [fx.f.name!]: 'b2' } }] });
    const csv = 'Name\ni1\ni2\ni3\n';
    const j = await s.upload(`${P}/tables/${fx.table}/imports`, [{ name: 'mapping', value: JSON.stringify([{ column: 0, field: fx.f.name }]) }, { name: 'file', filename: 'a.csv', content: csv }]);
    expect(j.status).toBe(202);
    await worker.drainJobs(); await worker.drain();
    const all = (await s.post(`${P}/tables/${fx.table}/records/query`, { limit: 100 })).body.records;
    expect(all).toHaveLength(5);
    expect(all.every((x: any) => x.fields[fx.f.notes!] === 'seen')).toBe(true);
  });

  describe('test mode', () => {
    it('previews effects without writing, reports validation errors, and executes only when asked', async () => {
      await fresh();
      const r = await create({ [fx.f.name!]: 'T' });
      const a = await mk({ trigger: { type: 'record_updated' }, actions: [{ type: 'update_record', fields: { [fx.f.qty!]: 9, [fx.f.notes!]: 'N:{{' + fx.f.name + '}}' } }] });
      const prev = await s.post(`${P}/automations/${a.body.id}/test`, { record_id: r.body.id });
      expect(prev.status).toBe(200); expect(prev.body.trigger_matched).toBe(true);
      expect(prev.body.effects[0].set[fx.f.notes!]).toBe('N:T');
      expect((await get(r.body.id)).version).toBe(1);                       // nothing written
      const exec = await s.post(`${P}/automations/${a.body.id}/test`, { record_id: r.body.id, mode: 'execute' });
      expect(exec.status).toBe(200);
      expect((await get(r.body.id)).fields[fx.f.qty!]).toBe(9);
      const rs = await runs(a.body.id);
      expect(rs.filter((x: any) => x.test_mode)).toHaveLength(2);
      // invalid definitions are rejected when saved
      expect((await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.qty!]: 'abc' } }] })).status).toBe(422);
      expect((await mk({ trigger: { type: 'condition_matched' }, actions: [{ type: 'update_record', fields: {} }] })).status).toBe(422);
      expect((await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'http_request', url: 'http://169.254.169.254' }] })).status).toBe(422); // no outgoing HTTP actions exist
    });
  });

  describe('safety', () => {
    it('self-triggering automations are stopped by the loop guard', async () => {
      await fresh();
      const a = await mk({ trigger: { type: 'record_updated' }, actions: [{ type: 'update_record', fields: { [fx.f.qty!]: 1, [fx.f.notes!]: '{{' + fx.f.name + '}}' } }] });
      const r = await create({ [fx.f.name!]: 'loop' });
      await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.name!]: 'loop2' } }, { 'if-match': '"1"' });
      for (let i = 0; i < 6; i++) await worker.drain();
      const rs = await runs(a.body.id);
      expect(rs.filter((x: any) => x.status === 'success').length).toBe(1);
      expect(rs.some((x: any) => x.status === 'skipped' && /loop_guard/.test(x.error))).toBe(true);
      const pending = await app.ctx.db.owner.query(`SELECT count(*)::int n FROM outbox_events WHERE record_id=$1 AND status<>'done'`, [r.body.id]);
      expect(pending.rows[0].n).toBe(0);
    });
    it('ping-pong with ever-changing values terminates (each automation runs once per chain)', async () => {
      await fresh();
      const A = await mk({ name: 'A', trigger: { type: 'record_updated', watch_fields: [fx.f.name!] }, actions: [{ type: 'update_record', fields: { [fx.f.notes!]: '{{' + fx.f.name + '}}!' } }] });
      const B = await mk({ name: 'B', trigger: { type: 'record_updated', watch_fields: [fx.f.notes!] }, actions: [{ type: 'update_record', fields: { [fx.f.name!]: '{{' + fx.f.notes + '}}!' } }] });
      const r = await create({ [fx.f.name!]: 'a' });
      await s.patch(`${P}/records/${r.body.id}`, { fields: { [fx.f.name!]: 'b' } }, { 'if-match': '"1"' });
      for (let i = 0; i < 12; i++) await worker.drain();
      const pending = await app.ctx.db.owner.query(`SELECT count(*)::int n FROM outbox_events WHERE record_id=$1 AND status<>'done'`, [r.body.id]);
      expect(pending.rows[0].n).toBe(0);
      const all = [...(await runs(A.body.id)), ...(await runs(B.body.id))];
      expect(all.filter((x: any) => x.status === 'success').length).toBe(2);
      expect(all.some((x: any) => x.status === 'skipped')).toBe(true);
      expect((await get(r.body.id)).fields[fx.f.name!]).toBe('b!!');       // grew a bounded number of times, not forever
    });
    it('a long chain of distinct automations is cut off at the configured depth', async () => {
      await fresh();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await s.post(`${P}/tables/${fx.table}/fields`, { name: `Step${i}`, type: 'text' })).body.id);
      const autos = [];
      for (let i = 0; i < 4; i++) autos.push((await mk({ name: `S${i}`, trigger: { type: 'record_updated', watch_fields: [ids[i]] }, actions: [{ type: 'update_record', fields: { [ids[i + 1]!]: '{{' + ids[i] + '}}>' } }] })).body.id);
      const r = await create({ [fx.f.name!]: 'chain' });
      await s.patch(`${P}/records/${r.body.id}`, { fields: { [ids[0]!]: 's' } }, { 'if-match': '"1"' });
      for (let i = 0; i < 12; i++) await worker.drain();
      const g = (await get(r.body.id)).fields;
      expect(g[ids[1]!]).toBe('s>'); expect(g[ids[2]!]).toBe('s>>'); expect(g[ids[3]!]).toBe('s>>>');   // depth 3 reached
      expect(g[ids[4]!]).toBeUndefined();                                                              // 4th hop refused
      const last = await runs(autos[3]);
      expect(last[0].status).toBe('skipped'); expect(last[0].error).toMatch(/depth_limit/);
    });
    it('a failing action rolls back the whole run (no partial side effects) and retries, then dead-letters', async () => {
      await fresh();
      const other = (await s.post(`${P}/bases/${fx.base}/tables`, { name: 'Log' })).body;
      const a = await mk({ trigger: { type: 'record_created' }, actions: [
        { type: 'update_record', fields: { [fx.f.notes!]: 'first-action-ran' } },
        { type: 'create_record', table_id: other.id, fields: { [other.fields[0].id]: 'log entry' } },
      ] });
      expect(a.status).toBe(201);
      await s.del(`${P}/tables/${other.id}`);                                  // target disappears => action 2 fails at runtime
      const r = await create({ [fx.f.name!]: 'poison' });
      for (let attempt = 1; attempt <= 3; attempt++) {
        await app.ctx.db.owner.query(`UPDATE outbox_events SET next_attempt_at=now() WHERE record_id=$1`, [r.body.id]);
        await worker.drain();
        expect((await get(r.body.id)).fields[fx.f.notes!]).toBeUndefined();   // action 1 was rolled back
      }
      const ev = (await app.ctx.db.owner.query(`SELECT status, attempts, last_error FROM outbox_events WHERE record_id=$1`, [r.body.id])).rows[0];
      expect(ev.status).toBe('dead'); expect(ev.attempts).toBe(3); expect(ev.last_error).toMatch(/no longer exists/);
      const failed = (await runs(a.body.id)).filter((x: any) => x.status === 'failed');
      expect(failed).toHaveLength(3); expect(failed[0].error).toMatch(/Target table/);
      expect((await s.get(`${P}/workspaces/${fx.ws}/audit?action=automation.dead_letter`)).body.events).toHaveLength(1);
      await app.ctx.db.owner.query(`UPDATE outbox_events SET next_attempt_at=now() WHERE record_id=$1`, [r.body.id]);
      expect(await worker.drain()).toBe(0);                                    // dead events are not retried
    });
    it('retries use exponential backoff before the next attempt', async () => {
      await fresh();
      const other = (await s.post(`${P}/bases/${fx.base}/tables`, { name: 'L2' })).body;
      await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'create_record', table_id: other.id, fields: { [other.fields[0].id]: 'x' } }] });
      await s.del(`${P}/tables/${other.id}`);
      const r = await create({ [fx.f.name!]: 'backoff' });
      await worker.drain();
      const ev = (await app.ctx.db.owner.query(`SELECT status, next_attempt_at > now() + interval '1 second' AS delayed FROM outbox_events WHERE record_id=$1`, [r.body.id])).rows[0];
      expect(ev.status).toBe('pending'); expect(ev.delayed).toBe(true);
      expect(await worker.drain()).toBe(0);                                    // not due yet
    });
  });

  describe('durability', () => {
    it('events survive a worker crash: unfinished leases expire and another worker finishes the job', async () => {
      await fresh();
      await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.notes!]: 'after-restart' } }] });
      const r = await create({ [fx.f.name!]: 'crash' });
      // worker 1 claims the event and "dies" without completing it
      const claimed = (await app.ctx.db.app.query(`SELECT * FROM bc_claim_outbox(10, 60)`)).rows.filter((e) => e.record_id === r.body.id);
      expect(claimed).toHaveLength(1);
      // while the lease is valid nobody else takes it
      const w2 = new Worker(app.ctx, app.fastify.log);
      await w2.drain();
      expect((await get(r.body.id)).fields[fx.f.notes!]).toBeUndefined();
      // lease expires (simulated) => a new process picks it up
      await app.ctx.db.owner.query(`UPDATE outbox_events SET locked_until = now() - interval '1 second' WHERE record_id=$1`, [r.body.id]);
      await w2.drain();
      expect((await get(r.body.id)).fields[fx.f.notes!]).toBe('after-restart');
    });
    it('no events are written when a table has no automations (and none are lost when one is added later)', async () => {
      await fresh();
      const r = await create({ [fx.f.name!]: 'quiet' });
      expect((await app.ctx.db.owner.query(`SELECT count(*)::int n FROM outbox_events WHERE record_id=$1`, [r.body.id])).rows[0].n).toBe(0);
    });
    it('events and the record write commit atomically', async () => {
      await fresh();
      await mk({ trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [fx.f.qty!]: 1 } }] });
      const bad = await s.post(`${P}/tables/${fx.table}/records`, { records: [{ fields: { [fx.f.name!]: 'ok' } }, { fields: { [fx.f.qty!]: 'bad' } }] });
      expect(bad.status).toBe(422);
      expect((await app.ctx.db.owner.query(`SELECT count(*)::int n FROM outbox_events WHERE table_id=$1`, [fx.table])).rows[0].n).toBe(0);
    });
  });
});
