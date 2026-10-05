import { useId, useMemo, useState } from 'react';
import { ApiError, post } from '../api';
import { CellEditor } from '../components/CellEditor';
import { errText } from '../components/ui';
import { isReadonly } from '../lib/format';
import type { Field, ViewConfig, ViewProps } from '../types';

type FormCfg = NonNullable<ViewConfig['form']>;
type FormField = FormCfg['fields'][number];

/** Drops null/empty values but keeps false and 0. */
export function answersToPayload(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

export function FormView(props: ViewProps & { canDesign: boolean }) {
  const form = props.config.form;
  const empty = !form || form.fields.length === 0;
  const [designing, setDesigning] = useState(props.canDesign && empty);
  return (
    <div className="form-shell">
      {props.canDesign && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="spacer" />
          <button type="button" className="btn" aria-pressed={designing} onClick={() => setDesigning(!designing)}>{designing ? 'Back to form' : 'Design form'}</button>
        </div>
      )}
      {designing && props.canDesign
        ? <FormDesigner fields={props.fields} form={form} onChange={(f) => props.onConfigChange({ form: f })} />
        : empty
          ? <div className="empty">This form isn't set up yet. Ask someone with design access to choose which fields it should ask for.</div>
          : <FormFill key={props.view.id} {...props} form={form!} />}
    </div>
  );
}

function FormFill({ view, fields, form }: ViewProps & { form: FormCfg }) {
  const uid = useId();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const items = form.fields.map((ff) => ({ ff, field: fields.find((f) => f.id === ff.field) })).filter((x): x is { ff: FormField; field: Field } => !!x.field);

  const reset = () => { setValues({}); setErrors({}); setSummary(null); setDone(null); };
  if (done !== null) {
    return (
      <div role="status" aria-live="polite">
        <h2>{form.title || view.name}</h2>
        <div className="banner">{done}</div>
        <button type="button" className="btn" autoFocus onClick={reset}>Submit another response</button>
      </div>
    );
  }
  const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    for (const { ff, field } of items) if (ff.required && isEmpty(values[field.id])) local[field.id] = 'This question is required';
    if (Object.keys(local).length) { setErrors(local); setSummary(`Please answer ${Object.keys(local).length} required question(s).`); return; }
    setSending(true); setErrors({}); setSummary(null);
    try {
      const r = await post<{ record_id: string; message: string }>(`/views/${view.id}/submit`, { fields: answersToPayload(values) });
      setDone(r.message || form.successMessage || 'Thanks, your response was recorded.');
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) { setErrors(err.fieldErrors); setSummary(err.message); }
      else setSummary(errText(err));
    } finally { setSending(false); }
  };
  const errCount = Object.keys(errors).length;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${uid}-t`}>
      <h2 id={`${uid}-t`}>{form.title || view.name}</h2>
      {form.description && <p className="muted">{form.description}</p>}
      {summary && <div className="banner error" role="alert">{summary}{errCount > 0 && <ul>{items.filter((x) => errors[x.field.id]).map((x) => <li key={x.field.id}>{x.ff.label || x.field.name}: {errors[x.field.id]}</li>)}</ul>}</div>}
      {items.map(({ ff, field }) => {
        const id = `${uid}-${field.id}`;
        const err = errors[field.id];
        const desc = [ff.help ? `${id}-h` : '', err ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
        return (
          <div className="field" key={field.id}>
            <label htmlFor={id}>{ff.label || field.name}{ff.required && <span className="req" aria-hidden="true"> *</span>}{ff.required && <span className="sr-only"> (required)</span>}</label>
            {ff.help && <div className="hint" id={`${id}-h`}>{ff.help}</div>}
            <div>
              <DescribedEditor id={id} desc={desc} field={field} invalid={!!err} disabled={sending} value={values[field.id]} onChange={(v) => { setValues({ ...values, [field.id]: v }); if (err) setErrors(({ [field.id]: _, ...rest }) => rest); }} />
            </div>
            {err && <div className="err" id={`${id}-e`}>{err}</div>}
          </div>
        );
      })}
      <button type="submit" className="btn primary" disabled={sending}>{sending ? 'Sending…' : form.submitLabel || 'Submit'}</button>
    </form>
  );
}

/** CellEditor does not forward aria-describedby, so attach it to the rendered control after mount via a ref-free wrapper. */
function DescribedEditor({ id, desc, ...rest }: { id: string; desc?: string; field: Field; value: unknown; onChange(v: unknown): void; disabled?: boolean; invalid?: boolean }) {
  return (
    <span ref={(el) => {
      const c = el?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (c) { if (desc) c.setAttribute('aria-describedby', desc); else c.removeAttribute('aria-describedby'); }
    }} style={{ display: 'contents' }}><CellEditor id={id} {...rest} /></span>
  );
}

function FormDesigner({ fields, form, onChange }: { fields: Field[]; form?: FormCfg; onChange(f: FormCfg): void }) {
  const uid = useId();
  const cfg: FormCfg = form ?? { fields: [] };
  const writable = useMemo(() => fields.filter((f) => !isReadonly(f)), [fields]);
  const set = (patch: Partial<FormCfg>) => onChange({ ...cfg, ...patch });
  const upd = (i: number, patch: Partial<FormField>) => set({ fields: cfg.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, d: -1 | 1) => { const a = [...cfg.fields]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; set({ fields: a }); };
  const toggle = (id: string, on: boolean) => set({ fields: on ? [...cfg.fields, { field: id }] : cfg.fields.filter((f) => f.field !== id) });
  const text = (key: 'title' | 'description' | 'submitLabel' | 'successMessage', label: string, area = false) => (
    <div className="field">
      <label htmlFor={`${uid}-${key}`}>{label}</label>
      {area
        ? <textarea className="textarea" id={`${uid}-${key}`} value={cfg[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} />
        : <input className="input" id={`${uid}-${key}`} value={cfg[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} />}
    </div>
  );
  return (
    <div>
      <h2>Design form</h2>
      {text('title', 'Form title')}{text('description', 'Description', true)}{text('submitLabel', 'Submit button label')}{text('successMessage', 'Success message')}
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="label">Fields on the form</legend>
        {writable.map((f) => (
          <label key={f.id} className="row"><input type="checkbox" checked={cfg.fields.some((x) => x.field === f.id)} onChange={(e) => toggle(f.id, e.target.checked)} /> {f.name}</label>
        ))}
      </fieldset>
      {cfg.fields.length === 0 && <p className="hint" role="status">Choose at least one field to build the form.</p>}
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {cfg.fields.map((ff, i) => {
          const f = fields.find((x) => x.id === ff.field);
          if (!f) return null;
          return (
            <li key={ff.field} className="design-item">
              <div className="row"><strong>{f.name}</strong><span className="spacer" />
                <button type="button" className="btn small" disabled={i === 0} aria-label={`Move ${f.name} up`} onClick={() => move(i, -1)}>Up</button>
                <button type="button" className="btn small" disabled={i === cfg.fields.length - 1} aria-label={`Move ${f.name} down`} onClick={() => move(i, 1)}>Down</button>
              </div>
              <label className="row"><input type="checkbox" checked={!!ff.required} onChange={(e) => upd(i, { required: e.target.checked })} /> Required</label>
              <div className="field"><label htmlFor={`${uid}-l${i}`}>Label</label><input className="input" id={`${uid}-l${i}`} placeholder={f.name} value={ff.label ?? ''} onChange={(e) => upd(i, { label: e.target.value })} /></div>
              <div className="field"><label htmlFor={`${uid}-h${i}`}>Help text</label><input className="input" id={`${uid}-h${i}`} value={ff.help ?? ''} onChange={(e) => upd(i, { help: e.target.value })} /></div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
