import { CellDisplay } from '../components/CellEditor';
import { displayValue } from './format';
import type { Field } from '../types';

export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Compact, text-only rendering of a cell value for cards. Never renders HTML or attachment previews. */
export function CardValue({ field, value }: { field: Field; value: unknown }) {
  if (isEmptyValue(value)) return null;
  if (field.type === 'single_select' || field.type === 'multi_select') return <CellDisplay field={field} value={value} />;
  if (field.type === 'checkbox') return <span aria-label={value ? 'Checked' : 'Unchecked'}>{displayValue(field, value)}</span>;
  if (field.type === 'attachment') return <span className="card-attach"><span aria-hidden="true">📎 </span>{displayValue(field, value)}</span>;
  return <span className="card-text">{displayValue(field, value)}</span>;
}

export function CardFieldRows({ fields, values }: { fields: Field[]; values: Record<string, unknown> }) {
  const rows = fields.filter((f) => !isEmptyValue(values[f.id]));
  if (!rows.length) return null;
  return (
    <span className="card-fields">
      {rows.map((f) => (
        <span key={f.id} className="card-field"><span className="card-label">{f.name}</span><CardValue field={f} value={values[f.id]} /></span>
      ))}
    </span>
  );
}
