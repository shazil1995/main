import { FIELD_SQL_KIND } from '@basecraft/shared';
import type { Db } from './db.js';
import type { FieldRow } from './fieldTypes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INDEXABLE = new Set(['text', 'email', 'url', 'phone', 'integer', 'decimal', 'currency', 'percent', 'date', 'datetime', 'checkbox', 'single_select']);

const idxName = (tableId: string, fieldId: string) => `rx_${tableId.replace(/-/g, '').slice(0, 12)}_${fieldId.replace(/-/g, '').slice(0, 12)}`;

/**
 * Partial expression index on (value, seq) for ONE table's records. Created CONCURRENTLY by the owner role (outside any
 * transaction); table_id and field id are validated UUIDs, so inlining them is safe. Costs disk and write amplification;
 * enable only for fields that are frequently filtered or sorted (see PERFORMANCE.md).
 */
export async function setFieldIndex(db: Db, tableId: string, f: Pick<FieldRow, 'id' | 'type'>, on: boolean): Promise<void> {
  if (!UUID_RE.test(tableId) || !UUID_RE.test(f.id)) throw new Error('unsafe id');
  const name = idxName(tableId, f.id);
  if (!on) { await db.owner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`); return; }
  const kind = FIELD_SQL_KIND[f.type];
  const t = `("values"->>'${f.id}')`;
  const expr = kind === 'numeric' ? `((${t})::numeric)` : kind === 'boolean' ? `((${t})::boolean)` : `(${t})`;
  await db.owner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON records (${expr}, seq) WHERE table_id = '${tableId}'`);
}
