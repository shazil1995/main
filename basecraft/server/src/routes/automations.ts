import { z } from 'zod';
import { HttpError, notFound } from '../errors.js';
import { created, noContent, type AppContext } from '../http.js';
import { AutomationBody, runActions, triggerMatches, validateAutomation, type AutomationRow } from '../automations.js';
import { loadFields, getRecordForUpdate } from '../records.js';
import { actorOf } from '../types.js';
import { idParam, uuid, type Reg } from './common.js';

const cols = `id, table_id, name, enabled, trigger_type, trigger_config, conditions, actions, version, created_at, updated_at`;
const present = (r: any) => ({ id: r.id, table_id: r.table_id, name: r.name, enabled: r.enabled, trigger: { type: r.trigger_type, ...r.trigger_config }, conditions: r.conditions, actions: r.actions, version: r.version, created_at: r.created_at, updated_at: r.updated_at });
const split = (b: z.infer<typeof AutomationBody>) => { const { type, ...cfg } = b.trigger as any; return { type: type as string, cfg }; };

export function automationRoutes(reg: Reg, app: AppContext) {
  reg({
    method: 'GET', path: '/tables/:tableId/automations', tag: 'Automations', auth: 'session', summary: 'List automations for a table',
    params: idParam('tableId'), scope: { resource: 'table', param: 'tableId', permission: 'automations:read' },
    async handler(ctx) { return { automations: (await ctx.c!.query(`SELECT ${cols} FROM automations WHERE table_id=$1 ORDER BY created_at`, [ctx.params.tableId])).rows.map(present) }; },
  });

  reg({
    method: 'POST', path: '/tables/:tableId/automations', tag: 'Automations', auth: 'session',
    summary: 'Create an automation: trigger (record created/updated, condition matched, form submitted) → conditions → actions (update_record, create_record)',
    params: idParam('tableId'), body: AutomationBody, scope: { resource: 'table', param: 'tableId', permission: 'automations:write' },
    async handler(ctx) {
      await validateAutomation(ctx.c!, ctx.params.tableId, ctx.body);
      const { type, cfg } = split(ctx.body);
      const r = await ctx.c!.query(
        `INSERT INTO automations (workspace_id, table_id, name, enabled, trigger_type, trigger_config, conditions, actions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${cols}`,
        [ctx.access!.workspaceId, ctx.params.tableId, ctx.body.name, ctx.body.enabled, type, cfg, ctx.body.conditions ? JSON.stringify(ctx.body.conditions) : null, JSON.stringify(ctx.body.actions), (ctx.principal as any).userId]);
      await ctx.audit('automation.create', { type: 'automation', id: r.rows[0].id }, { name: ctx.body.name, trigger: type, enabled: ctx.body.enabled });
      return created(present(r.rows[0]));
    },
  });

  reg({
    method: 'PATCH', path: '/automations/:automationId', tag: 'Automations', auth: 'session', summary: 'Replace an automation definition (or toggle enabled)',
    params: idParam('automationId'), body: AutomationBody.partial({ name: true, enabled: true, trigger: true, actions: true }),
    scope: { resource: 'automation', param: 'automationId', permission: 'automations:write' },
    async handler(ctx) {
      const c = ctx.c!;
      const cur = (await c.query(`SELECT ${cols} FROM automations WHERE id=$1 FOR UPDATE`, [ctx.params.automationId])).rows[0];
      if (!cur) throw notFound('Automation');
      const merged = AutomationBody.parse({
        name: ctx.body.name ?? cur.name, enabled: ctx.body.enabled ?? cur.enabled,
        trigger: ctx.body.trigger ?? { type: cur.trigger_type, ...cur.trigger_config },
        conditions: ctx.body.conditions === undefined ? cur.conditions : ctx.body.conditions, actions: ctx.body.actions ?? cur.actions,
      });
      await validateAutomation(c, cur.table_id, merged);
      const { type, cfg } = split(merged);
      const r = await c.query(
        `UPDATE automations SET name=$2, enabled=$3, trigger_type=$4, trigger_config=$5, conditions=$6, actions=$7, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${cols}`,
        [cur.id, merged.name, merged.enabled, type, cfg, merged.conditions ? JSON.stringify(merged.conditions) : null, JSON.stringify(merged.actions)]);
      await ctx.audit('automation.update', { type: 'automation', id: cur.id }, { enabled: merged.enabled, trigger: type });
      return present(r.rows[0]);
    },
  });

  reg({
    method: 'DELETE', path: '/automations/:automationId', tag: 'Automations', auth: 'session', summary: 'Delete an automation and its run history',
    params: idParam('automationId'), scope: { resource: 'automation', param: 'automationId', permission: 'automations:write' },
    async handler(ctx) {
      await ctx.c!.query(`DELETE FROM automations WHERE id=$1`, [ctx.params.automationId]);
      await ctx.audit('automation.delete', { type: 'automation', id: ctx.params.automationId });
      return noContent();
    },
  });

  reg({
    method: 'POST', path: '/automations/:automationId/test', tag: 'Automations', auth: 'session',
    summary: 'Test against a real record. mode "preview" (default) validates and returns the effects WITHOUT writing; "execute" really performs the (internal) record actions. No outgoing HTTP/email action types exist yet.',
    params: idParam('automationId'), body: z.object({ record_id: uuid, mode: z.enum(['preview', 'execute']).default('preview'), event: z.enum(['created', 'updated']).default('updated') }).strict(),
    scope: { resource: 'automation', param: 'automationId', permission: 'automations:write' },
    async handler(ctx) {
      const c = ctx.c!, t0 = Date.now();
      const a = (await c.query(`SELECT ${cols} FROM automations WHERE id=$1`, [ctx.params.automationId])).rows[0] as AutomationRow;
      const rec = await getRecordForUpdate(c, a.table_id, ctx.body.record_id).catch(() => { throw notFound('Record'); });
      const fields = await loadFields(c, a.table_id);
      const ev = { type: ctx.body.event === 'created' ? 'record.created' : 'record.updated', record_id: rec.id, payload: { before: {}, after: rec.values, changed: Object.keys(rec.values) } };
      const matches = triggerMatches(a, ev, fields, { created_at: rec.created_at.toISOString(), updated_at: rec.updated_at.toISOString() });
      let effects: unknown[] = [], error: string | null = null;
      if (matches) {
        try {
          const base = (await c.query(`SELECT base_id FROM tables WHERE id=$1`, [a.table_id])).rows[0].base_id as string;
          effects = await runActions({ c, workspaceId: ctx.access!.workspaceId, baseId: base, tableId: a.table_id, actor: actorOf(ctx.principal), source: 'automation', depth: 1, visited: [a.id], ip: ctx.req.ip, traceId: ctx.traceId }, a, rec.id, rec.values, ctx.body.mode === 'preview');
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          error = e.message + (Array.isArray(e.details) ? ': ' + (e.details as any[]).map((d) => d.message).join('; ') : '');
        }
      }
      const status = error ? 'failed' : 'test';
      if (error && ctx.body.mode === 'execute') throw new HttpError(422, 'automation_test_failed', error); // roll back partial effects
      await c.query(`INSERT INTO automation_runs (workspace_id, automation_id, status, test_mode, started_at, finished_at, duration_ms, input, result, error) VALUES ($1,$2,$3,true,now(),now(),$4,$5,$6,$7)`,
        [ctx.access!.workspaceId, a.id, status === 'test' ? 'test' : 'failed', Date.now() - t0, JSON.stringify({ record_id: rec.id, event: ctx.body.event, mode: ctx.body.mode }), JSON.stringify({ trigger_matched: matches, effects }), error]);
      return { mode: ctx.body.mode, trigger_matched: matches, effects, error };
    },
  });

  reg({
    method: 'GET', path: '/automations/:automationId/runs', tag: 'Automations', auth: 'session', summary: 'Run history (inputs are redacted to ids; no record values are stored)',
    params: idParam('automationId'), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    scope: { resource: 'automation', param: 'automationId', permission: 'automations:read' },
    async handler(ctx) {
      const r = await ctx.c!.query(`SELECT id, event_id, status, test_mode, attempts, started_at, finished_at, duration_ms, input, result, error FROM automation_runs WHERE automation_id=$1 ORDER BY started_at DESC LIMIT $2`, [ctx.params.automationId, ctx.query.limit]);
      return { runs: r.rows };
    },
  });
}
