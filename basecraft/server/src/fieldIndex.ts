import { FIELD_SQL_KIND } from '@basecraft/shared';
import type { Db } from './db.js';
import type { FieldRow } from './fieldTypes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INDEXABLE = new Set(['text', 'email', 'url', 'phone', 'integer', 'decimal', 'currency', 'percent', 'date', 'datetime', 'checkbox', 'single_select']);

const idxName = (tableId: string, fieldId: string, suffix: 't' | 'n') => `rx_${tableId.replace(/-/g, '').slice(0, 12)}_${fieldId.replace(/-/g, '').slice(0, 12)}_${suffix}`;

/**
 * Partial expression indexes on (value, seq) for ONE table's records, created CONCURRENTLY by the owner role (outside any
 * transaction); table_id and field id are validated UUIDs, so inlining them is safe. Expressions use `bc_jtext`, the leakproof
 * alias of jsonb `->>`, so equality/range filters on the TEXT index and ORDER BY on either index are usable behind row-level security.
 *  - `_t` (text): equality, IN, is_empty, checkbox true/false, and range/sort for text, dates and datetimes (fixed-width, so text order == time order).
 *  - `_n` (numeric cast): numeric ORDER BY (integer/decimal/currency/percent) only; numeric comparison operators are not leakproof,
 *    so numeric RANGE filters (>, <) still scan. Both cost disk and write amplification: enable per field only where measured to help.
 */
export async function setFieldIndex(db: Db, tableId: string, f: Pick<FieldRow, 'id' | 'type'>, on: boolean): Promise<void> {
  if (!UUID_RE.test(tableId) || !UUID_RE.test(f.id)) throw new Error('unsafe id');
  const nameT = idxName(tableId, f.id, 't'), nameN = idxName(tableId, f.id, 'n');
  if (!on) {
    await db.owner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nameT}`);
    await db.owner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nameN}`);
    return;
  }
  const kind = FIELD_SQL_KIND[f.type];
  const t = `bc_jtext("values", '${f.id}')`;
  await db.owner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nameT} ON records ((${t}), seq) WHERE table_id = '${tableId}'`);
  if (kind === 'numeric') await db.owner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nameN} ON records (((${t})::numeric), seq) WHERE table_id = '${tableId}'`);
}
