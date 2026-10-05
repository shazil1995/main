import { z } from 'zod';
import { AUTOMATION_TRIGGERS } from '@basecraft/shared';
import type { Client } from './db.js';
import { HttpError, unprocessable } from './errors.js';
import { toCsvCell, type FieldRow } from './fieldTypes.js';
import { evalFilter } from './filterEval.js';
import { FilterSchema, type FilterNode } from './query.js';
import { createRecords, getRecordForUpdate, loadFields, prepareWrite, updateRecord, type WriteCtx } from './records.js';

const uuid = z.string().uuid();
export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record_created') }).strict(),
  z.object({ type: z.literal('record_updated'), watch_fields: z.array(uuid).max(50).optional() }).strict(),
  z.object({ type: z.literal('condition_matched') }).strict(),
  z.object({ type: z.literal('form_submitted'), view_id: uuid.optional() }).strict(),
]);
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_record'), fields: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal('create_record'), table_id: uuid, fields: z.record(z.string(), z.unknown()) }).strict(),
]);
export type Trigger = z.infer<typeof TriggerSchema>;
export type Action = z.infer<typeof ActionSchema>;
export const AutomationBody = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  conditions: FilterSchema.nullable().optional(),
  actions: z.array(ActionSchema).min(1).max(10),
}).strict();
void AUTOMATION_TRIGGERS;

export interface AutomationRow {
  id: string; table_id: string; name: string; enabled: boolean; trigger_type: string; trigger_config: any; conditions: FilterNode | null; actions: Action[];
}

const TEMPLATE = /\{\{\s*([0-9a-f-]{36})\s*\}\}/g;

/** Resolve {"$ref": fieldId} and "{{fieldId}}" placeholders against the triggering record. Pure; no eval. */
export function resolveTemplates(spec: Record<string, unknown>, fields: FieldRow[], values: Record<string, unknown>): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && '$ref' in (v as object)) {
      const ref = (v as { $ref: unknown }).$ref;
      out[k] = typeof ref === 'string' ? values[ref] ?? null : null;
    } else if (typeof v === 'string' && v.includes('{{')) {
      out[k] = v.replace(TEMPLATE, (_, id: string) => { const f = byId.get(id); return f ? toCsvCell(f, values[id]) : ''; });
    } else out[k] = v;
  }
  return out;
}

/** Static validation when saving: referenced tables/fields exist and literal values pass the field-type rules. */
export async function validateAutomation(c: Client, tableId: string, body: z.infer<typeof AutomationBody>): Promise<void> {
  const fields = await loadFields(c, tableId);
  const ids = new Set(fields.map((f) => f.id));
  const errs: { field: string; message: string }[] = [];
  if (body.trigger.type === 'condition_matched' && !body.conditions) errs.push({ field: 'conditions', message: 'A "condition matched" trigger needs conditions' });
  for (const w of body.trigger.type === 'record_updated' ? body.trigger.watch_fields ?? [] : []) if (!ids.has(w)) errs.push({ field: 'trigger.watch_fields', message: `Unknown field ${w}` });
  const check = (path: string, fs: FieldRow[], spec: Record<string, unknown>) => {
    const literal: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
      const isTemplate = (v && typeof v === 'object' && '$ref' in (v as object)) || (typeof v === 'string' && v.includes('{{'));
      if (!fs.some((f) => f.id === k)) errs.push({ field: `${path}.${k}`, message: 'Unknown field' });
      else if (!isTemplate) literal[k] = v;
    }
    try { prepareWrite(fs, literal); } catch (e) { if (e instanceof HttpError && Array.isArray(e.details)) for (const d of e.details as any[]) errs.push({ field: `${path}.${d.field}`, message: d.message }); else throw e; }
  };
  for (const [i, a] of body.actions.entries()) {
    if (a.type === 'update_record') check(`actions.${i}.fields`, fields, a.fields);
    else {
      const t = (await c.query(`SELECT 1 FROM tables WHERE id=$1 AND deleted_at IS NULL`, [a.table_id])).rowCount;
      if (!t) { errs.push({ field: `actions.${i}.table_id`, message: 'Unknown table' }); continue; }
      check(`actions.${i}.fields`, await loadFields(c, a.table_id), a.fields);
    }
  }
  if (errs.length) throw unprocessable('Invalid automation', errs);
}

export interface EventLike {
  type: string; record_id: string; payload: { before?: Record<string, unknown>; after?: Record<string, unknown>; changed?: string[] };
}

/** Does this automation's trigger fire for this event? Pure function: used by the worker and by tests. */
export function triggerMatches(a: Pick<AutomationRow, 'trigger_type' | 'trigger_config' | 'conditions'>, ev: EventLike, fields: FieldRow[], meta: { created_at?: string; updated_at?: string } = {}): boolean {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const after = ev.payload.after ?? {}, before = ev.payload.before ?? {};
  const cond = (vals: Record<string, unknown>) => !a.conditions || evalFilter(a.conditions, byId, vals, meta);
  switch (a.trigger_type) {
    case 'record_created': return (ev.type === 'record.created' || ev.type === 'form.submitted') && cond(after);
    case 'form_submitted': return ev.type === 'form.submitted' && cond(after);
    case 'record_updated': {
      if (ev.type !== 'record.updated') return false;
      const watch: string[] | undefined = a.trigger_config?.watch_fields;
      if (watch?.length && !(ev.payload.changed ?? []).some((c) => watch.includes(c))) return false;
      return cond(after);
    }
    case 'condition_matched': {
      if (!a.conditions) return false;
      if (ev.type === 'record.created' || ev.type === 'form.submitted') return cond(after);
      if (ev.type === 'record.updated') return cond(after) && !evalFilter(a.conditions, byId, before, meta);
      return false;
    }
    default: return false;
  }
}

export interface Effect { action: string; table_id: string; record_id?: string; set: Record<string, unknown> }

/**
 * Execute (or, with dryRun, only validate and describe) the actions against the triggering record.
 * Live execution writes through the SAME record service as the UI/API/imports, so audit rows and downstream events are identical.
 */
export async function runActions(w: WriteCtx, auto: AutomationRow, recordId: string, triggerValues: Record<string, unknown>, dryRun: boolean): Promise<Effect[]> {
  const effects: Effect[] = [];
  const triggerFields = await loadFields(w.c, auto.table_id);
  for (const a of auto.actions) {
    if (a.type === 'update_record') {
      const set = resolveTemplates(a.fields, triggerFields, triggerValues);
      const { set: ok, clear } = prepareWrite(triggerFields, set);
      effects.push({ action: 'update_record', table_id: auto.table_id, record_id: recordId, set: { ...ok, ...Object.fromEntries(clear.map((k) => [k, null])) } });
      if (!dryRun) {
        const cur = await getRecordForUpdate(w.c, auto.table_id, recordId).catch(() => null);
        if (cur) await updateRecord({ ...w, tableId: auto.table_id }, triggerFields, recordId, cur.version, set);
      }
    } else {
      const tf = await loadFields(w.c, a.table_id);
      const set = resolveTemplates(a.fields, triggerFields, triggerValues);
      const { set: ok } = prepareWrite(tf, set);
      effects.push({ action: 'create_record', table_id: a.table_id, set: ok });
      if (!dryRun) {
        const t = (await w.c.query(`SELECT base_id FROM tables WHERE id=$1 AND deleted_at IS NULL`, [a.table_id])).rows[0];
        if (!t) throw new HttpError(422, 'validation_failed', 'Target table no longer exists');
        await createRecords({ ...w, tableId: a.table_id, baseId: t.base_id, formSubmission: false }, tf, [set]);
      }
    }
  }
  return effects;
}
