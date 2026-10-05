import type { FieldRow } from './fieldTypes.js';
import { cmpDecimal } from './fieldTypes.js';
import { coerceScalar, optionIds, type FilterNode } from './query.js';
import { FIELD_SQL_KIND } from '@basecraft/shared';
import { ValueError } from './errors.js';

/** In-memory evaluation of the same filter language the SQL builder compiles, used for automation conditions. */
export function evalFilter(node: FilterNode, fields: Map<string, FieldRow>, values: Record<string, unknown>, meta: { created_at?: string; updated_at?: string } = {}): boolean {
  if ('and' in node) return node.and.every((n) => evalFilter(n, fields, values, meta));
  if ('or' in node) return node.or.some((n) => evalFilter(n, fields, values, meta));
  const f = fields.get(node.field);
  if (!f) return false;
  const v: unknown = f.type === 'created_time' ? meta.created_at : f.type === 'modified_time' ? meta.updated_at : values[f.id];
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const kind = FIELD_SQL_KIND[f.type];
  try {
    switch (node.op) {
      case 'is_empty': return empty;
      case 'is_not_empty': return !empty;
      case 'is_true': return v === true;
      case 'is_false': return v === false;
      case 'has_any': case 'has_all': case 'has_none': {
        const ids = optionIds(f, node.value);
        const have = Array.isArray(v) ? (v as string[]) : v == null ? [] : [v as string];
        if (node.op === 'has_any') return ids.some((i) => have.includes(i));
        if (node.op === 'has_all') return ids.every((i) => have.includes(i));
        return !ids.some((i) => have.includes(i));
      }
      case 'contains': return !empty && String(v).toLowerCase().includes(coerceScalar(f, node.value).toLowerCase());
      case 'not_contains': return empty || !String(v).toLowerCase().includes(coerceScalar(f, node.value).toLowerCase());
      case 'starts_with': return !empty && String(v).toLowerCase().startsWith(coerceScalar(f, node.value).toLowerCase());
      case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': {
        let c: number | null;
        if (f.type === 'single_select') { const want = optionIds(f, node.value)[0]!; c = empty ? null : v === want ? 0 : 1; }
        else if (empty) c = null;
        else {
          const want = coerceScalar(f, node.value);
          c = kind === 'numeric' ? cmpDecimal(String(v), want) : String(v) < want ? -1 : String(v) > want ? 1 : 0;
        }
        if (node.op === 'neq') return c === null || c !== 0;
        if (c === null) return false;
        return node.op === 'eq' ? c === 0 : node.op === 'gt' ? c > 0 : node.op === 'gte' ? c >= 0 : node.op === 'lt' ? c < 0 : c <= 0;
      }
    }
  } catch (e) { if (e instanceof ValueError) return false; throw e; }
}
