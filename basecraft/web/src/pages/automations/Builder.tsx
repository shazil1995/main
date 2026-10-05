import { useMutation } from '@tanstack/react-query';
import { AUTOMATION_TRIGGERS } from '@basecraft/shared';
import { useState } from 'react';
import { ApiError, patch, post } from '../../api';
import { Dialog, errText, useToast } from '../../components/ui';
import { FilterBuilder, cleanFilter, countConditions } from '../../components/FilterBuilder';
import { TRIGGER_LABELS, automationToDraft, draftToBody, emptyAction, emptyDraft, validateDraft, type ApiAutomation, type Draft, type TriggerType } from '../../lib/automationLogic';
import type { Field } from '../../types';
import { ActionEditor } from './ActionEditor';

export function Builder({ ws, tableId, fields, existing, onClose, onSaved }: { ws: string; tableId: string; fields: Field[]; existing?: ApiAutomation; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => (existing ? automationToDraft(existing) : emptyDraft()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: (body: unknown) => (existing ? patch(`/automations/${existing.id}`, body) : post(`/tables/${tableId}/automations`, body)),
    onSuccess: () => { toast.push('info', existing ? 'Automation saved' : 'Automation created'); onSaved(); },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
      else { setErrors({}); toast.push('error', errText(e)); }
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const cond = cleanFilter(d.conditions);
    const local = validateDraft(d, countConditions(cond) > 0);
    setErrors(local);
    if (Object.keys(local).length) return;
    save.mutate(draftToBody({ ...d, conditions: cond }));
  };
  const watchable = fields;
  return (
    <Dialog title={existing ? 'Edit automation' : 'New automation'} onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="au-name">Name</label>
          <input id="au-name" className="input" maxLength={200} value={d.name} aria-invalid={!!errors.name || undefined} onChange={(e) => set({ name: e.target.value })} />
          {errors.name && <div className="err" role="alert">{errors.name}</div>}</div>
        <div className="field"><label htmlFor="au-trig">Trigger</label>
          <select id="au-trig" className="select" value={d.trigger} onChange={(e) => set({ trigger: e.target.value as TriggerType })}>
            {AUTOMATION_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}</select>
          {d.trigger === 'condition_matched' && <span className="hint">Fires when a record starts matching the conditions below (new records that match, or updates that make it match).</span>}</div>
        {d.trigger === 'record_updated' && (
          <fieldset className="fs"><legend>Only when these fields change (optional)</legend>
            <div className="grid-2">{watchable.map((f) => (
              <label key={f.id} className="row"><input type="checkbox" checked={d.watch.includes(f.id)} onChange={(e) => set({ watch: e.target.checked ? [...d.watch, f.id] : d.watch.filter((x) => x !== f.id) })} /> {f.name}</label>))}</div>
            {errors['trigger.watch_fields'] && <div className="err" role="alert">{errors['trigger.watch_fields']}</div>}
          </fieldset>
        )}
        <fieldset className="fs"><legend>Conditions{d.trigger === 'condition_matched' ? ' (required)' : ' (optional)'}</legend>
          <FilterBuilder fields={fields} value={d.conditions} onChange={(v) => set({ conditions: v })} />
          {errors.conditions && <div className="err" role="alert">{errors.conditions}</div>}
        </fieldset>
        <h3>Actions</h3>
        {errors.actions && <div className="err" role="alert">{errors.actions}</div>}
        {d.actions.map((a, i) => (
          <ActionEditor key={a.key} ws={ws} index={i} action={a} source={fields} sourceTableId={tableId} errors={errors}
            onChange={(n) => set({ actions: d.actions.map((x) => (x.key === a.key ? n : x)) })} onRemove={() => set({ actions: d.actions.filter((x) => x.key !== a.key) })} />
        ))}
        <div className="row wrap">
          <button type="button" className="btn" disabled={d.actions.length >= 10} onClick={() => set({ actions: [...d.actions, emptyAction()] })}>Add action</button>
          <span className="hint">{d.actions.length}/10. No outgoing HTTP or email actions exist in this version (they will need credentials, approval and SSRF controls).</span>
        </div>
        {Object.keys(errors).length > 0 && (
          <div className="banner error" role="alert"><strong>Please fix:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.entries(errors).map(([k, v]) => <li key={k}><code>{k}</code>: {v}</li>)}</ul></div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <label className="row"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save automation'}</button>
        </div>
      </form>
    </Dialog>
  );
}
