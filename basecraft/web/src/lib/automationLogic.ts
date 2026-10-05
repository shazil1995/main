import type { FilterNode } from '../types';

export type TriggerType = 'record_created' | 'record_updated' | 'condition_matched' | 'form_submitted';
export const TRIGGER_LABELS: Record<TriggerType, string> = {
  record_created: 'When a record is created', record_updated: 'When a record is updated',
  condition_matched: 'When a record starts matching conditions', form_submitted: 'When a form is submitted',
};

export type ValueMode = 'value' | 'ref';
export interface FieldRow { key: string; fieldId: string; mode: ValueMode; value: unknown; refId: string }
export interface ActionDraft { key: string; type: 'update_record' | 'create_record'; tableId: string; rows: FieldRow[] }
export interface Draft { name: string; enabled: boolean; trigger: TriggerType; watch: string[]; conditions: FilterNode | undefined; actions: ActionDraft[] }

export interface ApiAction { type: 'update_record' | 'create_record'; table_id?: string; fields: Record<string, unknown> }
export interface ApiAutomation {
  id: string; table_id: string; name: string; enabled: boolean;
  trigger: { type: TriggerType; watch_fields?: string[]; view_id?: string }; conditions: FilterNode | null; actions: ApiAction[];
}

let n = 0;
export const newKey = () => `k${++n}`;
export const emptyRow = (): FieldRow => ({ key: newKey(), fieldId: '', mode: 'value', value: null, refId: '' });
export const emptyAction = (type: ActionDraft['type'] = 'update_record'): ActionDraft => ({ key: newKey(), type, tableId: '', rows: [emptyRow()] });
export const emptyDraft = (): Draft => ({ name: '', enabled: true, trigger: 'record_created', watch: [], conditions: undefined, actions: [emptyAction()] });

export const isRef = (v: unknown): v is { $ref: string } => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).$ref === 'string';

export function rowsToFields(rows: FieldRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (!r.fieldId) continue;
    if (r.mode === 'ref') { if (r.refId) out[r.fieldId] = { $ref: r.refId }; }
    else out[r.fieldId] = r.value === undefined ? null : r.value;
  }
  return out;
}
export function fieldsToRows(fields: Record<string, unknown>): FieldRow[] {
  const rows = Object.entries(fields).map(([fieldId, v]): FieldRow => isRef(v)
    ? { key: newKey(), fieldId, mode: 'ref', value: null, refId: v.$ref }
    : { key: newKey(), fieldId, mode: 'value', value: v, refId: '' });
  return rows.length ? rows : [emptyRow()];
}

export function draftToBody(d: Draft) {
  const trigger = d.trigger === 'record_updated' ? { type: d.trigger, ...(d.watch.length ? { watch_fields: d.watch } : {}) } : { type: d.trigger };
  return {
    name: d.name.trim(), enabled: d.enabled, trigger, conditions: d.conditions ?? null,
    actions: d.actions.map((a) => a.type === 'update_record' ? { type: a.type, fields: rowsToFields(a.rows) } : { type: a.type, table_id: a.tableId, fields: rowsToFields(a.rows) }),
  };
}
export function automationToDraft(a: ApiAutomation): Draft {
  return {
    name: a.name, enabled: a.enabled, trigger: a.trigger.type, watch: a.trigger.watch_fields ?? [], conditions: a.conditions ?? undefined,
    actions: a.actions.map((x) => ({ key: newKey(), type: x.type, tableId: x.table_id ?? '', rows: fieldsToRows(x.fields) })),
  };
}

/** Client-side checks that give instant feedback; the server remains authoritative. Returns messages keyed by server-style path. */
export function validateDraft(d: Draft, hasConditions: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = 'Name is required';
  if (d.trigger === 'condition_matched' && !hasConditions) e.conditions = 'A "condition matched" trigger needs at least one condition';
  if (d.actions.length < 1) e.actions = 'Add at least one action';
  if (d.actions.length > 10) e.actions = 'At most 10 actions';
  d.actions.forEach((a, i) => {
    if (a.type === 'create_record' && !a.tableId) e[`actions.${i}.table_id`] = 'Choose a target table';
    const seen = new Set<string>();
    for (const r of a.rows) {
      if (!r.fieldId) continue;
      if (seen.has(r.fieldId)) e[`actions.${i}.fields`] = 'A field is set more than once';
      seen.add(r.fieldId);
      if (r.mode === 'ref' && !r.refId) e[`actions.${i}.fields.${r.fieldId}`] = 'Choose a source field';
    }
    if (!seen.size) e[`actions.${i}.fields`] = 'Set at least one field';
  });
  return e;
}

export const insertPlaceholder = (text: string, fieldId: string) => `${text}{{${fieldId}}}`;
export const hasPlaceholder = (v: unknown) => typeof v === 'string' && /\{\{\s*[0-9a-f-]{36}\s*\}\}/.test(v);

export function triggerSummary(a: Pick<ApiAutomation, 'trigger' | 'conditions'>, fieldName: (id: string) => string): string {
  let s = TRIGGER_LABELS[a.trigger.type];
  if (a.trigger.type === 'record_updated' && a.trigger.watch_fields?.length) s += ` (only when ${a.trigger.watch_fields.map(fieldName).join(', ')} changes)`;
  if (a.conditions) s += ' with conditions';
  return s;
}

/** Map server error paths onto the nearest builder location (exact path first, then the parent prefix). */
export function errorFor(errors: Record<string, string>, path: string): string | undefined {
  return errors[path];
}
export function errorsUnder(errors: Record<string, string>, prefix: string): [string, string][] {
  return Object.entries(errors).filter(([k]) => k === prefix || k.startsWith(prefix + '.'));
}
