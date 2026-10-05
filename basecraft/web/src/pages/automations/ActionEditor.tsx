import { useTable } from '../../lib/queries';
import type { ActionDraft } from '../../lib/automationLogic';
import { errorsUnder } from '../../lib/automationLogic';
import type { Field } from '../../types';
import { FieldValues } from './FieldValues';
import { useBaseTables } from '../settings/resources';

export function ActionEditor({ ws, index, action, source, sourceTableId, errors, onChange, onRemove }: {
  ws: string; index: number; action: ActionDraft; source: Field[]; sourceTableId: string; errors: Record<string, string>; onChange(a: ActionDraft): void; onRemove(): void;
}) {
  const { items } = useBaseTables(ws);
  const targetId = action.type === 'update_record' ? sourceTableId : action.tableId;
  const target = useTable(targetId || undefined);
  const base = `actions.${index}`;
  const prefix = `${base}.fields.`;
  const rowErrors: Record<string, string> = {};
  for (const [k, v] of errorsUnder(errors, `${base}.fields`)) if (k.startsWith(prefix)) rowErrors[k.slice(prefix.length)] = v;
  const general = errors[`${base}.fields`] ?? errors[base];
  return (
    <fieldset className="fs action">
      <legend>Action {index + 1}</legend>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor={`a${index}-type`}>Type</label>
          <select id={`a${index}-type`} className="select" value={action.type} onChange={(e) => onChange({ ...action, type: e.target.value as ActionDraft['type'], rows: action.rows.map((r) => ({ ...r, fieldId: '', value: null })) })}>
            <option value="update_record">Update this record</option><option value="create_record">Create a record in a table</option>
          </select></div>
        {action.type === 'create_record' && (
          <div className="field" style={{ margin: 0 }}><label htmlFor={`a${index}-tbl`}>Target table</label>
            <select id={`a${index}-tbl`} className="select" value={action.tableId} aria-invalid={!!errors[`${base}.table_id`] || undefined} onChange={(e) => onChange({ ...action, tableId: e.target.value, rows: action.rows.map((r) => ({ ...r, fieldId: '', value: null })) })}>
              <option value="">Choose…</option>
              {items.map(({ base: b, tables }) => <optgroup key={b.id} label={b.name}>{tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>)}
            </select>
            {errors[`${base}.table_id`] && <div className="err" role="alert">{errors[`${base}.table_id`]}</div>}</div>
        )}
        <span className="spacer" />
        <button type="button" className="btn small danger" onClick={onRemove}>Remove action {index + 1}</button>
      </div>
      {general && <div className="err" role="alert">{general}</div>}
      {targetId && target.isLoading ? <div className="hint" role="status">Loading fields…</div> : (
        <FieldValues idPrefix={`a${index}`} target={target.data?.fields ?? []} source={source} rows={action.rows} errors={rowErrors} onChange={(rows) => onChange({ ...action, rows })} />
      )}
    </fieldset>
  );
}
