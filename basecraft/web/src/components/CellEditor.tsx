import { useEffect, useRef, useState } from 'react';
import { ApiError, api, del } from '../api';
import { colorFor, fromLocalInput, isReadonly, optionById, selectOptions, toLocalInput } from '../lib/format';
import type { ApiRecord, Field } from '../types';
import { useToast, errText } from './ui';

/**
 * Controlled editor for one field value, used by the record panel, forms and kanban quick-edit.
 * It emits API-shaped values (strings for decimals, option ids, UTC/naive datetimes) and never rounds numbers itself.
 */
export function CellEditor({ field, value, onChange, disabled, id, invalid, onCommit }: {
  field: Field; value: unknown; onChange(v: unknown): void; disabled?: boolean; id?: string; invalid?: boolean; onCommit?(): void;
}) {
  const common = { id, disabled, 'aria-invalid': invalid || undefined, onBlur: onCommit } as const;
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && field.type !== 'long_text') onCommit?.(); };
  switch (field.type) {
    case 'long_text':
      return <textarea className="textarea" {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'checkbox':
      return (
        <label className="row"><input type="checkbox" id={id} disabled={disabled} checked={value === true} aria-checked={value === true ? 'true' : value === false ? 'false' : 'mixed'}
          onChange={(e) => { onChange(e.target.checked); setTimeout(() => onCommit?.(), 0); }} /> <span className="muted">{value === true ? 'Checked' : value === false ? 'Unchecked' : 'Not set'}</span></label>
      );
    case 'single_select':
      return (
        <select className="select" {...common} value={(value as string) ?? ''} onChange={(e) => { onChange(e.target.value || null); setTimeout(() => onCommit?.(), 0); }}>
          <option value="">—</option>
          {selectOptions(field).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      );
    case 'multi_select': {
      const cur = new Set((value as string[] | undefined) ?? []);
      return (
        <div role="group" aria-label={field.name} className="row wrap">
          {selectOptions(field).map((o) => (
            <label key={o.id} className="row" style={{ gap: 4 }}>
              <input type="checkbox" disabled={disabled} checked={cur.has(o.id)} onChange={(e) => { const n = new Set(cur); e.target.checked ? n.add(o.id) : n.delete(o.id); onChange(n.size ? [...n] : null); }} />
              <span className="chip" style={{ background: colorFor(o) }}>{o.name}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'date':
      return <input type="date" className="input" {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} onKeyDown={onKey} />;
    case 'datetime':
      return (
        <div>
          <input type="datetime-local" step={1} className="input" {...common} value={value ? toLocalInput(value as string, field.options.timezone) : ''} onChange={(e) => onChange(fromLocalInput(e.target.value, field.options.timezone))} onKeyDown={onKey} />
          <div className="hint">{field.options.timezone ? `Time zone: ${field.options.timezone}` : 'Your local time zone'}</div>
        </div>
      );
    case 'integer':
      return <input className="input" inputMode="numeric" {...common} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value.trim() === '' ? null : /^[+-]?\d+$/.test(e.target.value.trim()) ? Number(e.target.value.trim()) : e.target.value)} onKeyDown={onKey} />;
    case 'decimal': case 'currency': case 'percent':
      return (
        <div className="row">
          {field.type === 'currency' && <span className="badge">{field.options.currency}</span>}
          <input className="input" inputMode="decimal" {...common} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value.trim() === '' ? null : e.target.value.trim())} onKeyDown={onKey} />
          {field.type === 'percent' && <span className="muted">%</span>}
        </div>
      );
    case 'created_time': case 'modified_time':
      return <div className="muted">{value ? new Date(value as string).toLocaleString() : '—'}</div>;
    case 'attachment':
      return <div className="hint">Attachments are managed in the record panel.</div>;
    default:
      return <input className="input" {...common} type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : 'text'} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} onKeyDown={onKey} />;
  }
}

/** Attachment list with upload/remove. Files go to /records/:id/attachments (multipart); blob bytes never touch record JSON. */
export function AttachmentCell({ record, field, canEdit, onChanged }: { record: ApiRecord; field: Field; canEdit: boolean; onChanged(): void }) {
  const files: any[] = record.fields[field.id] ?? [];
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = async (file: File) => {
    setBusy(true);
    try { const fd = new FormData(); fd.append('file', file); await api('POST', `/records/${record.id}/attachments?field_id=${field.id}`, fd); onChanged(); toast.push('info', `Uploaded ${file.name}`); }
    catch (e) { toast.push('error', errText(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div>
      {files.length === 0 && <div className="hint">No files</div>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 6px' }}>
        {files.map((a) => (
          <li key={a.id} className="row" style={{ padding: '2px 0' }}>
            <a href={`/api/v1/attachments/${a.id}/download`} download>{a.filename}</a>
            <span className="hint">{(a.size / 1024).toFixed(1)} KB</span>
            {canEdit && <button className="btn small ghost" aria-label={`Remove ${a.filename}`} onClick={async () => { try { await del(`/attachments/${a.id}`); onChanged(); } catch (e) { toast.push('error', errText(e)); } }}>Remove</button>}
          </li>
        ))}
      </ul>
      {canEdit && (<><input ref={input} type="file" className="sr-only" id={`up-${field.id}`} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <label htmlFor={`up-${field.id}`} className="btn small" aria-disabled={busy}>{busy ? 'Uploading…' : 'Add file'}</label>
        <div className="hint">Images, PDF, Office, zip, txt/csv/json. HTML/SVG/scripts/executables are blocked.</div></>)}
    </div>
  );
}

export function CellDisplay({ field, value }: { field: Field; value: unknown }) {
  if (value === null || value === undefined) return null;
  if (field.type === 'single_select') { const o = optionById(field, value); return <span className="chip" style={{ background: colorFor(o) }}>{o?.name ?? String(value)}</span>; }
  if (field.type === 'multi_select') return <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>{(value as string[]).map((id) => { const o = optionById(field, id); return <span key={id} className="chip" style={{ background: colorFor(o) }}>{o?.name ?? id}</span>; })}</span>;
  return null;
}
export { ApiError, isReadonly };
