import { z } from 'zod';
import { VIEW_TYPES, VIEW_VISIBILITY } from '@basecraft/shared';
import { HttpError, forbidden, notFound } from '../errors.js';
import { created, noContent, type AppContext, type Ctx } from '../http.js';
import { loadFields, createRecords, loadAttachments } from '../records.js';
import { validateViewConfig, ViewConfigSchema } from '../viewConfig.js';
import { writeCtxFor } from './records.js';
import { idParam, name200, type Reg } from './common.js';

const vtype = z.enum(VIEW_TYPES), vis = z.enum(VIEW_VISIBILITY);

/** Who may change/delete a view: personal = its owner; shared = editors+; locked = admins+ (views:manage_locked). */
function assertCanEdit(ctx: Ctx, v: { visibility: string; owner_id: string }, targetVisibility?: string) {
  const p = ctx.principal!;
  const uid = p.type === 'user' ? p.userId : null;
  const need = (vis: string) => {
    if (vis === 'personal') { if (v.owner_id !== uid) throw forbidden('This is another user\'s personal view'); ctx.require('views:write_personal'); }
    else if (vis === 'shared') ctx.require('views:write_shared');
    else ctx.require('views:manage_locked');
  };
  need(v.visibility);
  if (targetVisibility && targetVisibility !== v.visibility) need(targetVisibility);
}

export function viewRoutes(reg: Reg, app: AppContext) {
  const tableP = idParam('tableId');

  reg({
    method: 'GET', path: '/tables/:tableId/views', tag: 'Views', auth: 'any', summary: 'List views you can see (shared, locked, and your personal views)',
    params: tableP, scope: { resource: 'table', param: 'tableId', permission: 'views:read' },
    async handler(ctx) {
      const p = ctx.principal!;
      const r = await ctx.c!.query(
        `SELECT id, name, type, visibility, owner_id, config, position, version, created_at, updated_at FROM views
          WHERE table_id=$1 AND (visibility <> 'personal' OR owner_id = $2) ORDER BY position, created_at`, [ctx.params.tableId, p.type === 'user' ? p.userId : '00000000-0000-0000-0000-000000000000']);
      return { views: r.rows };
    },
  });

  reg({
    method: 'POST', path: '/tables/:tableId/views', tag: 'Views', auth: 'session', summary: 'Save a view (grid, kanban, gallery, calendar, form)',
    params: tableP, body: z.object({ name: name200, type: vtype, visibility: vis.default('personal'), config: ViewConfigSchema.default({}) }).strict(),
    scope: { resource: 'table', param: 'tableId', permission: 'views:write_personal' },
    async handler(ctx) {
      const b = ctx.body;
      ctx.require(b.visibility === 'personal' ? 'views:write_personal' : b.visibility === 'shared' ? 'views:write_shared' : 'views:manage_locked');
      validateViewConfig(b.type, b.config, await loadFields(ctx.c!, ctx.params.tableId));
      const pos = (await ctx.c!.query(`SELECT coalesce(max(position),-1)+1 p FROM views WHERE table_id=$1`, [ctx.params.tableId])).rows[0].p;
      const r = await ctx.c!.query(
        `INSERT INTO views (workspace_id, table_id, name, type, visibility, owner_id, config, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, name, type, visibility, owner_id, config, position, version, created_at, updated_at`,
        [ctx.access!.workspaceId, ctx.params.tableId, b.name, b.type, b.visibility, (ctx.principal as any).userId, b.config, pos]);
      if (b.visibility !== 'personal') await ctx.audit('view.create', { type: 'view', id: r.rows[0].id }, { name: b.name, visibility: b.visibility });
      return created(r.rows[0]);
    },
  });

  reg({
    method: 'PATCH', path: '/views/:viewId', tag: 'Views', auth: 'session', summary: 'Update a view (name, config, visibility). Optional body.version guards against overwriting a teammate\'s change.',
    params: idParam('viewId'),
    body: z.object({ name: name200.optional(), visibility: vis.optional(), config: ViewConfigSchema.optional(), version: z.number().int().min(1).optional(), position: z.number().int().min(0).optional() }).strict(),
    scope: { resource: 'view', param: 'viewId', permission: 'views:read' },
    async handler(ctx) {
      const c = ctx.c!, b = ctx.body;
      const v = (await c.query(`SELECT * FROM views WHERE id=$1 FOR UPDATE`, [ctx.params.viewId])).rows[0];
      if (!v || (v.visibility === 'personal' && v.owner_id !== (ctx.principal as any).userId)) throw notFound('View');
      assertCanEdit(ctx, v, b.visibility);
      if (b.version !== undefined && b.version !== v.version) throw new HttpError(412, 'version_conflict', 'The view was changed by someone else. Reload and retry.', { current: v });
      const type = v.type;
      if (b.config) validateViewConfig(type, b.config, await loadFields(c, v.table_id));
      const r = await c.query(
        `UPDATE views SET name=coalesce($2,name), visibility=coalesce($3,visibility), config=coalesce($4,config), position=coalesce($5,position), version=version+1, updated_at=now()
          WHERE id=$1 RETURNING id, name, type, visibility, owner_id, config, position, version, created_at, updated_at`,
        [v.id, b.name ?? null, b.visibility ?? null, b.config ?? null, b.position ?? null]);
      if (v.visibility !== 'personal' || b.visibility) await ctx.audit('view.update', { type: 'view', id: v.id }, { visibility: r.rows[0].visibility });
      return r.rows[0];
    },
  });

  reg({
    method: 'DELETE', path: '/views/:viewId', tag: 'Views', auth: 'session', summary: 'Delete a view',
    params: idParam('viewId'), scope: { resource: 'view', param: 'viewId', permission: 'views:read' },
    async handler(ctx) {
      const v = (await ctx.c!.query(`SELECT * FROM views WHERE id=$1 FOR UPDATE`, [ctx.params.viewId])).rows[0];
      if (!v || (v.visibility === 'personal' && v.owner_id !== (ctx.principal as any).userId)) throw notFound('View');
      assertCanEdit(ctx, v);
      await ctx.c!.query(`DELETE FROM views WHERE id=$1`, [v.id]);
      if (v.visibility !== 'personal') await ctx.audit('view.delete', { type: 'view', id: v.id }, { name: v.name });
      return noContent();
    },
  });

  // ───────── form submission: only fields configured on the form can be written ─────────
  reg({
    method: 'POST', path: '/views/:viewId/submit', tag: 'Views', auth: 'session', idempotent: true,
    summary: 'Submit a form view. Only fields listed in the form configuration are accepted; required fields are enforced.',
    params: idParam('viewId'), body: z.object({ fields: z.record(z.string(), z.unknown()) }).strict(),
    scope: { resource: 'view', param: 'viewId', permission: 'forms:submit' },
    async handler(ctx) {
      const c = ctx.c!;
      const v = (await c.query(`SELECT * FROM views WHERE id=$1`, [ctx.params.viewId])).rows[0];
      if (!v || v.type !== 'form' || (v.visibility === 'personal' && v.owner_id !== (ctx.principal as any).userId)) throw notFound('Form');
      const cfg = ViewConfigSchema.parse(v.config);
      const allowed = new Map((cfg.form?.fields ?? []).map((f) => [f.field, f]));
      const errors: { field: string; message: string }[] = [];
      for (const k of Object.keys(ctx.body.fields)) if (!allowed.has(k)) errors.push({ field: k, message: 'This field is not part of the form' });
      for (const [id, f] of allowed) {
        const val = ctx.body.fields[id];
        if (f.required && (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length))) errors.push({ field: id, message: 'Required' });
      }
      if (errors.length) throw new HttpError(422, 'validation_failed', 'Please fix the highlighted answers', errors);
      const fields = await loadFields(c, v.table_id);
      const [rec] = await createRecords(writeCtxFor(ctx, v.table_id, { source: 'form', formSubmission: true }), fields, [ctx.body.fields]);
      return created({ record_id: rec!.id, message: cfg.form?.successMessage ?? 'Thanks — your response was recorded.' });
    },
  });
  void loadAttachments;
}
