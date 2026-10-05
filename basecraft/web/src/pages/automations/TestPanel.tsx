import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { post } from '../../api';
import { Spinner, errText, useConfirm, useToast } from '../../components/ui';
import { displayValue } from '../../lib/format';
import { useTable } from '../../lib/queries';
import type { ApiRecord, TableDetail } from '../../types';
import type { ApiAutomation } from '../../lib/automationLogic';

interface Effect { action: string; table_id: string; record_id?: string; set: Record<string, unknown> }
interface TestResult { mode: string; trigger_matched: boolean; effects: Effect[]; error: string | null }

export function TestPanel({ automation, table }: { automation: ApiAutomation; table: TableDetail }) {
  const toast = useToast(); const { confirm, node } = useConfirm();
  const primary = table.fields.find((f) => f.is_primary) ?? table.fields[0]!;
  const [input, setInput] = useState(''); const [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  const recs = useQuery({ queryKey: ['autoTestRecs', table.id, search], queryFn: () => post<{ records: ApiRecord[] }>(`/tables/${table.id}/records/query`, { search: search || undefined, limit: 10, fields: [primary.id] }) });
  const [recordId, setRecordId] = useState(''); const [event, setEvent] = useState<'created' | 'updated'>('updated'); const [mode, setMode] = useState<'preview' | 'execute'>('preview');
  const [result, setResult] = useState<TestResult | null>(null); const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => post<TestResult>(`/automations/${automation.id}/test`, { record_id: recordId, mode, event }),
    onMutate: () => { setResult(null); setErr(null); },
    onSuccess: setResult, onError: (e) => { setErr(errText(e)); toast.push('error', errText(e)); },
  });
  const go = async () => {
    if (mode === 'execute' && !(await confirm('Execute really runs the actions: records will be changed or created. Continue?', 'Execute for real'))) return;
    run.mutate();
  };
  return (
    <div>
      {node}
      <h3 style={{ marginTop: 0 }}>Test “{automation.name}”</h3>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div style={{ minWidth: 260, flex: 1 }}>
          <div className="field"><label htmlFor={`ts-${automation.id}`}>Find a record</label><input id={`ts-${automation.id}`} className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Search ${primary.name}`} /></div>
          <div role="radiogroup" aria-label="Record to test with" aria-live="polite">
            {recs.isLoading ? <Spinner /> : recs.data?.records.length === 0 ? <div className="hint">No records found.</div> : recs.data?.records.map((r) => (
              <label key={r.id} className="row" style={{ padding: '2px 0' }}><input type="radio" name={`rec-${automation.id}`} checked={recordId === r.id} onChange={() => setRecordId(r.id)} /> {displayValue(primary, r.fields[primary.id]) || <em className="muted">(empty)</em>}</label>
            ))}
            {recs.isError && <div className="err">{errText(recs.error)}</div>}
          </div>
        </div>
        <div style={{ minWidth: 240 }}>
          <fieldset className="fs"><legend>Simulate event</legend>
            <label className="row"><input type="radio" name={`ev-${automation.id}`} checked={event === 'created'} onChange={() => setEvent('created')} /> Record created</label>
            <label className="row"><input type="radio" name={`ev-${automation.id}`} checked={event === 'updated'} onChange={() => setEvent('updated')} /> Record updated (all fields changed)</label>
          </fieldset>
          <fieldset className="fs"><legend>Mode</legend>
            <label className="row"><input type="radio" name={`md-${automation.id}`} checked={mode === 'preview'} onChange={() => setMode('preview')} /> Preview (writes nothing)</label>
            <label className="row"><input type="radio" name={`md-${automation.id}`} checked={mode === 'execute'} onChange={() => setMode('execute')} /> Execute (really changes data)</label>
          </fieldset>
          <button className={`btn ${mode === 'execute' ? 'danger' : 'primary'}`} disabled={!recordId || run.isPending} onClick={go}>{run.isPending ? 'Running…' : mode === 'execute' ? 'Execute' : 'Preview'}</button>
        </div>
      </div>
      <div aria-live="polite" style={{ marginTop: 12 }}>
        {err && <div className="banner error" role="alert">{err}</div>}
        {result && (
          <div className="card">
            <p style={{ marginTop: 0 }}><strong>Trigger matched:</strong> {result.trigger_matched ? 'yes' : 'no'}{!result.trigger_matched && <span className="hint"> — with this record and event, the trigger or conditions would not fire.</span>}</p>
            {result.error && <div className="banner error"><strong>Error:</strong> {result.error}</div>}
            {result.effects.length > 0 && <p className="hint">{result.mode === 'preview' ? 'Would do (nothing was written):' : 'Did:'}</p>}
            <ol style={{ margin: 0, paddingLeft: 20 }}>{result.effects.map((e, i) => <li key={i}><EffectView e={e} /></li>)}</ol>
          </div>
        )}
      </div>
    </div>
  );
}

function EffectView({ e }: { e: Effect }) {
  const t = useTable(e.table_id);
  const entries = Object.entries(e.set);
  return (
    <div>
      <strong>{e.action === 'update_record' ? 'Update record' : 'Create record'}</strong> in {t.data?.name ?? 'table'}{e.record_id && <span className="mono hint"> {e.record_id}</span>}
      {entries.length === 0 ? <span className="hint"> (no fields)</span> : (
        <ul style={{ margin: '2px 0' }}>{entries.map(([id, v]) => {
          const f = t.data?.fields.find((x) => x.id === id);
          return <li key={id}>{f?.name ?? id}: <code>{f ? (displayValue(f, v) || '(empty)') : JSON.stringify(v)}</code></li>;
        })}</ul>
      )}
    </div>
  );
}
