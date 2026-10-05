import { z } from 'zod';
import { FIELD_TYPES, LIMITS, type SelectOption } from '@basecraft/shared';
import { hiddenResourceIds } from '../authz.js';
import { conflict, notFound, unprocessable, ValueError } from '../errors.js';
import { INDEXABLE, setFieldIndex } from '../fieldIndex.js';
import { newOptionId, normalizeFieldOptions } from '../fieldTypes.js';
import { created, noContent, type AppContext } from '../http.js';
import { loadFields } from '../records.js';
import { idParam, name200, uuid, type Reg } from './common.js';
import type { Client } from '../db.js';

const fieldSpec = z.object({ name: name200, type: z.enum(FIELD_TYPES), options: z.record(z.string(), z.unknown()).optional() }).strict();

function optionsOrThrow(type: any, opts: Record<string, any> | undefined) {
  try { return normalizeFieldOptions(type, opts); }
  catch (e) { if (e instanceof ValueError) throw unprocessable('Invalid field options', [{ field: 'options', message: e.message }]); throw e; }
}

async function insertField(c: Client, ws: string, tableId: string, spec: z.infer<typeof fieldSpec>, primary = false) {
  const count = (await c.query(`SELECT count(*)::int n, coalesce(max(position),-1)+1 AS pos FROM fields WHERE table_id=$1 AND deleted_at IS NULL`, [tableId])).rows[0];
  if (count.n >= LIMITS.maxFieldsPerTable) throw unprocessable(`A table can have at most ${LIMITS.maxFieldsPerTable} fields`);
  const options = optionsOrThrow(spec.type, spec.options);
  try {
    const r = await c.query(
      `INSERT INTO fields (workspace_id, table_id, name, type, options, position, is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, type, options, position, is_primary, indexed`, [ws, tableId, spec.name, spec.type, options, count.pos, primary]);
    return r.rows[0];
  } catch (e: any) {
    if (e.code === '23505') throw conflict(`A field named "${spec.name}" already exists`, 'field_name_taken');
    throw e;
  }
}

export function schemaRoutes(reg: Reg, app: AppContext) {
  // ───────── bases ─────────
  reg({
    method: 'GET', path: '/workspaces/:workspaceId/bases', tag: 'Schema', auth: 'any', summary: 'List bases',
    params: idParam('workspaceId'), scope: { resource: 'workspace', param: 'workspaceId', permission: 'schema:read' },
    async handler(ctx) {
      const hidden = await hiddenResourceIds(ctx.c!, ctx.principal!, ctx.params.workspaceId);
      const r = await ctx.c!.query(`SELECT id, name, created_at FROM bases WHERE deleted_at IS NULL ORDER BY created_at`);
      const p = ctx.principal!;
      return { bases: r.rows.filter((b) => !hidden.none.has(b.id) && (p.type !== 'token' || !p.baseIds || p.baseIds.includes(b.id) || !!p.tableIds)) };
    },
  });

  reg({
    method: 'POST', path: '/workspaces/:workspaceId/bases', tag: 'Schema', auth: 'session', summary: 'Create a base',
    params: idParam('workspaceId'), body: z.object({ name: name200 }).strict(),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'schema:write' },
    async handler(ctx) {
      const r = await ctx.c!.query(`INSERT INTO bases (workspace_id, name) VALUES ($1,$2) RETURNING id, name, created_at`, [ctx.params.workspaceId, ctx.body.name]);
      await ctx.audit('base.create', { type: 'base', id: r.rows[0].id }, { name: ctx.body.name });
      return created(r.rows[0]);
    },
  });

  reg({
    method: 'PATCH', path: '/bases/:baseId', tag: 'Schema', auth: 'session', summary: 'Rename a base',
    params: idParam('baseId'), body: z.object({ name: name200 }).strict(),
    scope: { resource: 'base', param: 'baseId', permission: 'schema:write' },
    async handler(ctx) {
      await ctx.c!.query(`UPDATE bases SET name=$2 WHERE id=$1`, [ctx.params.baseId, ctx.body.name]);
      await ctx.audit('base.rename', { type: 'base', id: ctx.params.baseId }, { name: ctx.body.name });
      return { ok: true };
    },
  });

  reg({
    method: 'DELETE', path: '/bases/:baseId', tag: 'Schema', auth: 'session', summary: 'Delete a base (soft delete; data is retained and recoverable by an operator)',
    params: idParam('baseId'), scope: { resource: 'base', param: 'baseId', permission: 'schema:write' },
    async handler(ctx) {
      await ctx.c!.query(`UPDATE bases SET deleted_at = now() WHERE id=$1`, [ctx.params.baseId]);
      await ctx.audit('base.delete', { type: 'base', id: ctx.params.baseId });
      return noContent();
    },
  });

  // ───────── tables ─────────
  reg({
    method: 'GET', path: '/bases/:baseId/tables', tag: 'Schema', auth: 'any', summary: 'List tables in a base',
    params: idParam('baseId'), scope: { resource: 'base', param: 'baseId', permission: 'schema:read' },
    async handler(ctx) {
      const hidden = await hiddenResourceIds(ctx.c!, ctx.principal!, ctx.access!.workspaceId);
      const r = await ctx.c!.query(`SELECT id, base_id, name, position, created_at FROM tables WHERE base_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`, [ctx.params.baseId]);
      const p = ctx.principal!;
      return { tables: r.rows.filter((t) => !hidden.none.has(t.id) && (p.type !== 'token' || !p.tableIds || p.tableIds.includes(t.id))) };
    },
  });

  reg({
    method: 'POST', path: '/bases/:baseId/tables', tag: 'Schema', auth: 'session', summary: 'Create a table (a primary "Name" text field is added if none is given)',
    params: idParam('baseId'), body: z.object({ name: name200, fields: z.array(fieldSpec).max(LIMITS.maxFieldsPerTable).optional() }).strict(),
    scope: { resource: 'base', param: 'baseId', permission: 'schema:write' },
    async handler(ctx) {
      const c = ctx.c!, ws = ctx.access!.workspaceId;
      const pos = (await c.query(`SELECT coalesce(max(position),-1)+1 AS p FROM tables WHERE base_id=$1`, [ctx.params.baseId])).rows[0].p;
      const t = (await c.query(`INSERT INTO tables (workspace_id, base_id, name, position) VALUES ($1,$2,$3,$4) RETURNING id, base_id, name, position, created_at`, [ws, ctx.params.baseId, ctx.body.name, pos])).rows[0];
      const specs = ctx.body.fields?.length ? ctx.body.fields : [{ name: 'Name', type: 'text' as const }];
      const fields = [];
      for (let i = 0; i < specs.length; i++) fields.push(await insertField(c, ws, t.id, specs[i]!, i === 0));
      await c.query(
        `INSERT INTO views (workspace_id, table_id, name, type, visibility, owner_id, config) VALUES ($1,$2,'Grid view','grid','shared',$3,'{}')`, [ws, t.id, (ctx.principal as any).userId]);
      await ctx.audit('table.create', { type: 'table', id: t.id }, { name: t.name, fields: fields.length });
      return created({ ...t, fields });
    },
  });

  reg({
    method: 'GET', path: '/tables/:tableId', tag: 'Schema', auth: 'any', summary: 'Table with its fields',
    params: idParam('tableId'), scope: { resource: 'table', param: 'tableId', permission: 'schema:read' },
    async handler(ctx) {
      const t = (await ctx.c!.query(`SELECT id, base_id, name, position, created_at FROM tables WHERE id=$1`, [ctx.params.tableId])).rows[0];
      return { ...t, fields: await loadFields(ctx.c!, t.id), role: ctx.access!.role };
    },
  });

  reg({
    method: 'PATCH', path: '/tables/:tableId', tag: 'Schema', auth: 'session', summary: 'Rename a table',
    params: idParam('tableId'), body: z.object({ name: name200 }).strict(),
    scope: { resource: 'table', param: 'tableId', permission: 'schema:write' },
    async handler(ctx) {
      await ctx.c!.query(`UPDATE tables SET name=$2 WHERE id=$1`, [ctx.params.tableId, ctx.body.name]);
      await ctx.audit('table.rename', { type: 'table', id: ctx.params.tableId }, { name: ctx.body.name });
      return { ok: true };
    },
  });

  reg({
    method: 'DELETE', path: '/tables/:tableId', tag: 'Schema', auth: 'session', summary: 'Delete a table (soft delete)',
    params: idParam('tableId'), scope: { resource: 'table', param: 'tableId', permission: 'schema:write' },
    async handler(ctx) {
      await ctx.c!.query(`UPDATE tables SET deleted_at = now() WHERE id=$1`, [ctx.params.tableId]);
      await ctx.c!.query(`UPDATE automations SET enabled=false WHERE table_id=$1`, [ctx.params.tableId]);
      await ctx.audit('table.delete', { type: 'table', id: ctx.params.tableId });
      return noContent();
    },
  });

  // ───────── fields ─────────
  reg({
    method: 'GET', path: '/tables/:tableId/fields', tag: 'Schema', auth: 'any', summary: 'List fields',
    params: idParam('tableId'), scope: { resource: 'table', param: 'tableId', permission: 'schema:read' },
    async handler(ctx) { return { fields: await loadFields(ctx.c!, ctx.params.tableId) }; },
  });

  reg({
    method: 'POST', path: '/tables/:tableId/fields', tag: 'Schema', auth: 'session', summary: 'Add a field',
    params: idParam('tableId'), body: fieldSpec, scope: { resource: 'table', param: 'tableId', permission: 'schema:write' },
    async handler(ctx) {
      const f = await insertField(ctx.c!, ctx.access!.workspaceId, ctx.params.tableId, ctx.body);
      await ctx.audit('field.create', { type: 'field', id: f.id }, { table_id: ctx.params.tableId, name: f.name, type: f.type });
      return created(f);
    },
  });

  reg({
    method: 'PATCH', path: '/fields/:fieldId', tag: 'Schema', auth: 'session',
    summary: 'Rename / reorder a field, edit select options, or toggle its expression index. Field TYPE cannot change in Phase 1 (see FEATURE_PARITY.md).',
    params: idParam('fieldId'),
    body: z.object({
      name: name200.optional(), position: z.number().int().min(0).max(1000).optional(), indexed: z.boolean().optional(),
      options: z.object({ options: z.array(z.object({ id: z.string().optional(), name: z.string().min(1).max(100), color: z.string().optional() })).max(200) }).strict().optional(),
    }).strict(),
    scope: { resource: 'field', param: 'fieldId', permission: 'schema:write' },
    async handler(ctx) {
      const c = ctx.c!, b = ctx.body;
      const f = (await c.query(`SELECT * FROM fields WHERE id=$1 FOR UPDATE`, [ctx.params.fieldId])).rows[0];
      if (!f) throw notFound('Field');
      let options = f.options;
      if (b.options) {
        if (f.type !== 'single_select' && f.type !== 'multi_select') throw unprocessable('Only select fields have editable options');
        const existing: SelectOption[] = f.options.options ?? [];
        const next = optionsOrThrow(f.type, { options: b.options.options.map((o) => ({ ...o, id: o.id && existing.some((e) => e.id === o.id) ? o.id : undefined })) });
        const removed = existing.filter((e) => !next.options.some((n: SelectOption) => n.id === e.id)).map((e) => e.id);
        if (removed.length) {
          const used = (await c.query(
            `SELECT count(*)::int n FROM records WHERE table_id=$1 AND ("values"->>$2 = ANY($3::text[]) OR "values"->$2 ?| $3::text[])`, [f.table_id, f.id, removed])).rows[0].n;
          if (used > 0) throw conflict(`${used} record(s) still use a removed option. Clear those values first.`, 'option_in_use', { records: used });
        }
        options = next;
      }
      if (b.indexed !== undefined && b.indexed && !INDEXABLE.has(f.type)) throw unprocessable(`${f.type} fields cannot be indexed`);
      try {
        await c.query(`UPDATE fields SET name = coalesce($2, name), position = coalesce($3, position), options = $4 WHERE id=$1`, [f.id, b.name ?? null, b.position ?? null, options]);
      } catch (e: any) { if (e.code === '23505') throw conflict(`A field named "${b.name}" already exists`, 'field_name_taken'); throw e; }
      if (b.indexed !== undefined && b.indexed !== f.indexed) {
        await c.query(`UPDATE fields SET indexed=$2 WHERE id=$1`, [f.id, b.indexed]);
        // CREATE INDEX CONCURRENTLY cannot run inside our transaction; run it after commit
        const job = { tableId: f.table_id as string, field: { id: f.id as string, type: f.type }, on: b.indexed };
        ctx.onCommit(() => setFieldIndex(app.db, job.tableId, job.field, job.on));
      }
      await ctx.audit('field.update', { type: 'field', id: f.id }, { name: b.name, position: b.position, indexed: b.indexed, options_changed: !!b.options });
      const out = (await c.query(`SELECT id, name, type, options, position, is_primary, indexed FROM fields WHERE id=$1`, [f.id])).rows[0];
      return out;
    },
  });

  reg({
    method: 'DELETE', path: '/fields/:fieldId', tag: 'Schema', auth: 'session', summary: 'Delete a field (soft: stored values are retained so the field can be restored by an operator)',
    params: idParam('fieldId'), scope: { resource: 'field', param: 'fieldId', permission: 'schema:write' },
    async handler(ctx) {
      const f = (await ctx.c!.query(`SELECT id, table_id, is_primary, indexed, type FROM fields WHERE id=$1 FOR UPDATE`, [ctx.params.fieldId])).rows[0];
      if (f.is_primary) throw conflict('The primary field cannot be deleted', 'primary_field');
      // rename so the name can be reused; values stay in records."values" under the immutable field id
      await ctx.c!.query(`UPDATE fields SET deleted_at = now(), indexed = false WHERE id=$1`, [f.id]);
      if (f.indexed) ctx.onCommit(() => setFieldIndex(app.db, f.table_id, { id: f.id, type: f.type }, false));
      await ctx.audit('field.delete', { type: 'field', id: f.id }, { table_id: f.table_id });
      return noContent();
    },
  });
  void uuid;
}

