import { useState } from 'react';
import { Dialog, errText } from './ui';
import { post } from '../api';
import type { Field, SortSpec, ViewConfig } from '../types';
import { LIMITS } from '@basecraft/shared';

export const orderedFields = (fields: Field[], cfg: ViewConfig): Field[] => {
  const order = cfg.fieldOrder ?? [];
  const idx = (f: Field) => { const i = order.indexOf(f.id); return i === -1 ? 1000 + f.position : i; };
  return [...fields].sort((a, b) => idx(a) - idx(b));
};
export const visibleFields = (fields: Field[], cfg: ViewConfig): Field[] => orderedFields(fields, cfg).filter((f) => !(cfg.hiddenFields ?? []).includes(f.id));

export function FieldsMenu({ fields, config, onChange, onAddField, canAdd }: { fields: Field[]; config: ViewConfig; onChange(p: Partial<ViewConfig>): void; onAddField(): void; canAdd: boolean }) {
  const all = orderedFields(fields, config);
  const hidden = new Set(config.hiddenFields ?? []);
  const move = (i: number, d: -1 | 1) => { const ids = all.map((f) => f.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; onChange({ fieldOrder: ids }); };
  return (
    <div style={{ minWidth: 280 }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Fields">
        {all.map((f, i) => (
          <li key={f.id} className="row" style={{ padding: '2px 0' }}>
            <label className="row" style={{ flex: 1 }}>
              <input type="checkbox" checked={!hidden.has(f.id)} disabled={f.is_primary} onChange={(e) => onChange({ hiddenFields: e.target.checked ? [...hidden].filter((x) => x !== f.id) : [...hidden, f.id] })} />
              <span>{f.name}</span><span className="hint">{f.type.replace('_', ' ')}</span>
            </label>
            <button className="btn small ghost" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="btn small ghost" aria-label={`Move ${f.name} down`} disabled={i === all.length - 1} onClick={() => move(i, 1)}>↓</button>
          </li>
        ))}
      </ul>
      {canAdd && <button className="btn small" style={{ marginTop: 6 }} onClick={onAddField}>+ Add field</button>}
    </div>
  );
}

export function SortMenu({ fields, value, onChange }: { fields: Field[]; value: SortSpec[]; onChange(v: SortSpec[]): void }) {
  const sortable = fields.filter((f) => f.type !== 'attachment' && f.type !== 'multi_select');
  return (
    <div style={{ minWidth: 320 }}>
      {value.map((s, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <select className="select" aria-label={`Sort ${i + 1} field`} value={s.field} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
            {sortable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="select" style={{ width: 130 }} aria-label={`Sort ${i + 1} direction`} value={s.direction} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, direction: e.target.value as 'asc' | 'desc' } : x)))}>
            <option value="asc">A → Z / 1 → 9</option><option value="desc">Z → A / 9 → 1</option>
          </select>
          <button className="btn small ghost" aria-label="Remove sort" onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {value.length < LIMITS.maxSorts && <button className="btn small" onClick={() => onChange([...value, { field: sortable.find((f) => !value.some((v) => v.field === f.id))?.id ?? sortable[0]!.id, direction: 'asc' }])}>+ Add sort</button>}
      {!value.length && <p className="hint">Records appear in the order they were created.</p>}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  text: 'Single line text', long_text: 'Long text', integer: 'Whole number', decimal: 'Decimal', currency: 'Currency', percent: 'Percent', date: 'Date', datetime: 'Date & time',
  checkbox: 'Checkbox', single_select: 'Single select', multi_select: 'Multiple select', email: 'Email', url: 'URL', phone: 'Phone', created_time: 'Created time', modified_time: 'Last modified time', attachment: 'Attachments',
};
export function AddFieldDialog({ tableId, onClose, onCreated }: { tableId: string; onClose(): void; onCreated(): void }) {
  const [name, setName] = useState(''), [type, setType] = useState('text'), [err, setErr] = useState('');
  const [currency, setCurrency] = useState('USD'), [scale, setScale] = useState(2), [choices, setChoices] = useState(''), [tz, setTz] = useState('');
  const zones: string[] = (Intl as any).supportedValuesOf?.('timeZone') ?? [];
  const currencies: string[] = (Intl as any).supportedValuesOf?.('currency') ?? ['USD'];
  const options = (): Record<string, unknown> => {
    if (type === 'currency') return { currency };
    if (type === 'decimal' || type === 'percent') return { scale };
    if (type === 'single_select' || type === 'multi_select') return { options: choices.split('\n').map((s) => s.trim()).filter(Boolean) };
    if (type === 'datetime' && tz) return { timezone: tz };
    return {};
  };
  return (
    <Dialog title="Add field" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await post(`/tables/${tableId}/fields`, { name, type, options: options() }); onCreated(); onClose(); } catch (x) { setErr(errText(x)); } }}>
        <div className="field"><label htmlFor="fname">Field name</label><input id="fname" className="input" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="ftype">Type</label>
          <select id="ftype" className="select" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <span className="hint">The type cannot be changed later in this version.</span></div>
        {type === 'currency' && <div className="field"><label htmlFor="cur">Currency (ISO 4217)</label><select id="cur" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></div>}
        {(type === 'decimal' || type === 'percent') && <div className="field"><label htmlFor="scale">Decimal places</label><input id="scale" type="number" min={0} max={8} className="input" value={scale} onChange={(e) => setScale(Number(e.target.value))} /></div>}
        {(type === 'single_select' || type === 'multi_select') && <div className="field"><label htmlFor="opts">Options (one per line)</label><textarea id="opts" className="textarea" value={choices} onChange={(e) => setChoices(e.target.value)} /></div>}
        {type === 'datetime' && <div className="field"><label htmlFor="tz">Time zone (optional)</label><select id="tz" className="select" value={tz} onChange={(e) => setTz(e.target.value)}><option value="">None — require an explicit UTC offset</option>{zones.map((z) => <option key={z}>{z}</option>)}</select><span className="hint">With a zone, local times are interpreted there; times that don’t exist or repeat at a daylight-saving change are rejected.</span></div>}
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Add field</button></div>
      </form>
    </Dialog>
  );
}
