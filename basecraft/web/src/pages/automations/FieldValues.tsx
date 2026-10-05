import { CellEditor } from '../../components/CellEditor';
import { isReadonly, isTextType } from '../../lib/format';
import { emptyRow, hasPlaceholder, insertPlaceholder, type FieldRow } from '../../lib/automationLogic';
import type { Field } from '../../types';

/** Editable list of "field -> value" rows. `source` are the fields of the record that triggers the automation. */
export function FieldValues({ idPrefix, target, source, rows, onChange, errors }: {
  idPrefix: string; target: Field[]; source: Field[]; rows: FieldRow[]; onChange(r: FieldRow[]): void; errors: Record<string, string>;
}) {
  const writable = target.filter((f) => !isReadonly(f));
  const upd = (key: string, patch: Partial<FieldRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((r, n) => {
        const f = target.find((x) => x.id === r.fieldId);
        const err = errors[r.fieldId];
        return (
          <div key={r.key} className="fv-row">
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`${idPrefix}-f${n}`}>Field</label>
              <select id={`${idPrefix}-f${n}`} className="select" value={r.fieldId} onChange={(e) => upd(r.key, { fieldId: e.target.value, value: null })}>
                <option value="">Choose…</option>
                {writable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <span className="label" id={`${idPrefix}-v${n}-l`}>Value</span>
              {f ? (r.mode === 'ref' ? (
                <select className="select" aria-labelledby={`${idPrefix}-v${n}-l`} value={r.refId} onChange={(e) => upd(r.key, { refId: e.target.value })}>
                  <option value="">Choose a field of this record…</option>
                  {source.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              ) : (
                <div aria-labelledby={`${idPrefix}-v${n}-l`} role="group">
                  <CellEditor field={f} value={r.value} onChange={(v) => upd(r.key, { value: v })} invalid={!!err} />
                  {isTextType(f.type) && (
                    <div className="row wrap" style={{ marginTop: 4 }}>
                      <label className="hint" htmlFor={`${idPrefix}-p${n}`}>Insert field reference</label>
                      <select id={`${idPrefix}-p${n}`} className="select" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && upd(r.key, { value: insertPlaceholder(typeof r.value === 'string' ? r.value : '', e.target.value) })}>
                        <option value="">Choose…</option>
                        {source.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                      {hasPlaceholder(r.value) && <span className="hint">Placeholders are replaced with this record’s value when the automation runs.</span>}
                    </div>
                  )}
                </div>
              )) : <div className="hint">Choose a field first</div>}
              {err && <div className="err" role="alert">{err}</div>}
            </div>
            <div className="fv-ctl">
              {f && <label className="row"><input type="checkbox" checked={r.mode === 'ref'} onChange={(e) => upd(r.key, { mode: e.target.checked ? 'ref' : 'value' })} /> Use value from this record’s field…</label>}
              <button type="button" className="btn small danger" aria-label={`Remove field row ${n + 1}`} onClick={() => onChange(rows.length > 1 ? rows.filter((x) => x.key !== r.key) : [emptyRow()])}>Remove</button>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn small" onClick={() => onChange([...rows, emptyRow()])}>Add field</button>
      <p className="hint">Text values can embed another field of the triggering record as <code>{'{{fieldId}}'}</code>: use “Insert field reference” to add one. Or tick “Use value from this record’s field…” to copy a whole value.</p>
    </div>
  );
}
