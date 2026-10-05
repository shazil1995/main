import { csvSafeCell } from '@basecraft/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '../api';
import { csvEscape, downloadBlob } from '../lib/csv';
import { isReadonly } from '../lib/format';
import type { Field, TableDetail } from '../types';
import { Dialog, errText } from './ui';

const MAX_BYTES = 50 * 1024 * 1024;
interface RowErr { row: number; column?: number; field?: string; message: string }
interface Preview { header: string[]; sample: string[][]; row_count: number; columns: number; suggested_mapping: { column: number; field: string | null }[]; validated_rows: number; errors: RowErr[] }
interface Job {
  id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; rows_total: number | null; rows_processed: number;
  rows_created: number; rows_updated: number; rows_skipped: number; rows_failed: number; errors: RowErr[] | null; last_error: string | null; options?: { validate_only?: boolean };
}
const FINAL = new Set(['done', 'failed', 'cancelled']);

export function ImportDialog({ table, fields, onClose }: { table: TableDetail; fields: Field[]; onClose(): void }) {
  const qc = useQueryClient();
  const writable = useMemo(() => fields.filter((f) => !isReadonly(f)), [fields]);
  const [file, setFile] = useState<File | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<number, string>>({});
  const [dup, setDup] = useState<'create' | 'skip' | 'update'>('create');
  const [matchField, setMatchField] = useState('');
  const [onError, setOnError] = useState<'abort' | 'skip_rows'>('abort');
  const [dry, setDry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<RowErr[] | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const step = job ? 3 : preview ? 2 : 1;

  const mapping = () => Object.entries(map).filter(([, f]) => f).map(([c, f]) => ({ column: Number(c), field: f }));
  const header = (i?: number) => (i === undefined ? '' : preview?.header[i] || `Column ${i + 1}`);
  const mappedFields = new Set(Object.values(map).filter(Boolean));
  const dupFree = mappedFields.size === mapping().length;
  const needsMatch = dup !== 'create';
  const canRun = mapping().length > 0 && dupFree && (!needsMatch || (!!matchField && mappedFields.has(matchField))) && !busy;

  const upload = async (withMapping: boolean) => {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('has_header', String(hasHeader));
    if (withMapping) fd.append('mapping', JSON.stringify(mapping()));
    return post<Preview>(`/tables/${table.id}/imports/preview`, fd);
  };

  const pickFile = (f: File | null) => {
    setError(null); setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setError('This file is larger than 50 MB. Split it into smaller files.'); return; }
    setFile(f);
  };
  const doPreview = async () => {
    setBusy(true); setError(null);
    try {
      const pv = await upload(false);
      if (!pv) return;
      setPreview(pv);
      const m: Record<number, string> = {};
      for (const s of pv.suggested_mapping) if (s.field && writable.some((f) => f.id === s.field)) m[s.column] = s.field;
      setMap(m);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setError(null);
    try { setChecked((await upload(true))?.errors ?? []); } catch (e) { setError(errText(e)); setChecked(null); } finally { setBusy(false); }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mapping', JSON.stringify(mapping()));
      fd.append('options', JSON.stringify({ has_header: hasHeader, duplicate_policy: dup, ...(needsMatch ? { match_field: matchField } : {}), on_error: onError, validate_only: dry }));
      setJob(await post<Job>(`/tables/${table.id}/imports`, fd));
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  // poll the job; the interval is cleared on unmount and once the job reaches a final state
  const jobId = job?.id, jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || (jobStatus && FINAL.has(jobStatus))) return;
    let live = true;
    const t = setInterval(async () => {
      try { const j = await get<Job>(`/imports/${jobId}`); if (live) setJob(j); } catch (e) { if (live) setError(errText(e)); }
    }, 1000);
    return () => { live = false; clearInterval(t); };
  }, [jobId, jobStatus]);
  const invalidated = useRef(false);
  useEffect(() => {
    if (job && FINAL.has(job.status) && !invalidated.current) { invalidated.current = true; qc.invalidateQueries({ queryKey: ['records', table.id] }); }
  }, [job, qc, table.id]);

  const jobAction = async (what: 'cancel' | 'resume') => {
    if (!job) return;
    setError(null);
    try { invalidated.current = false; setJob(await post<Job>(`/imports/${job.id}/${what}`)); } catch (e) { setError(errText(e)); }
  };
  const downloadErrors = () => {
    const lines = ['row,column,message', ...(job?.errors ?? []).map((e) => [e.row, csvEscape(csvSafeCell(header(e.column))), csvEscape(csvSafeCell(e.message))].join(','))];
    downloadBlob('﻿' + lines.join('\r\n') + '\r\n', `import-errors-${job?.id.slice(0, 8)}.csv`);
  };

  return (
    <Dialog title={`Import CSV into ${table.name}`} onClose={onClose} wide>
      <ol className="wizard-steps" aria-label="Import steps">
        {['Choose file', 'Map columns', 'Import'].map((s, i) => <li key={s} aria-current={step === i + 1 ? 'step' : undefined}>{i + 1}. {s}</li>)}
      </ol>
      {error && <div className="banner error" role="alert">{error}</div>}

      {step === 1 && (
        <div>
          <div className="field">
            <label htmlFor="imp-file">CSV file (max 50 MB)</label>
            <input id="imp-file" type="file" accept=".csv,text/csv" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            {file && <div className="hint">{file.name} — {(file.size / 1024).toFixed(1)} KB</div>}
          </div>
          <label className="row"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row contains headers</label>
          <div className="row" style={{ marginTop: 14 }}><span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!file || busy} onClick={doPreview}>{busy ? 'Reading…' : 'Next'}</button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div>
          <p>{preview.row_count} data row{preview.row_count === 1 ? '' : 's'} found in {file?.name}.</p>
          <table className="table-simple map-table">
            <thead><tr><th scope="col">CSV column</th><th scope="col">Import into</th><th scope="col">Sample values</th></tr></thead>
            <tbody>
              {Array.from({ length: preview.columns }, (_, i) => {
                const taken = (fid: string) => mappedFields.has(fid) && map[i] !== fid;
                const samples = preview.sample.slice(0, 5).map((r) => r[i] ?? '').join(' · ');
                return (
                  <tr key={i}>
                    <th scope="row" id={`col-${i}`}>{header(i)}</th>
                    <td>
                      <select className="select" aria-labelledby={`col-${i}`} value={map[i] ?? ''} onChange={(e) => { setChecked(null); setMap({ ...map, [i]: e.target.value }); }}>
                        <option value="">Don't import</option>
                        {writable.map((f) => <option key={f.id} value={f.id} disabled={taken(f.id)}>{f.name}{taken(f.id) ? ' (already mapped)' : ''}</option>)}
                      </select>
                    </td>
                    <td className="map-samples" title={samples}>{samples}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <details style={{ margin: '8px 0' }}>
            <summary>How values are converted</summary>
            <ul className="hint">
              <li>yes/no/true/false become checkbox values.</li>
              <li>Thousands separators and currency symbols are stripped from numbers.</li>
              <li>Multi-select cells are split on ; , or |.</li>
              <li>Select values must match an existing option name.</li>
            </ul>
          </details>
          <div className="field">
            <label htmlFor="imp-dup">Existing records</label>
            <select id="imp-dup" className="select" value={dup} onChange={(e) => setDup(e.target.value as typeof dup)}>
              <option value="create">Create new records</option><option value="skip">Skip duplicates</option><option value="update">Update existing records</option>
            </select>
          </div>
          {needsMatch && (
            <div className="field">
              <label htmlFor="imp-match">Match on</label>
              <select id="imp-match" className="select" value={matchField} onChange={(e) => setMatchField(e.target.value)} aria-describedby="imp-match-h">
                <option value="">Choose a mapped field…</option>
                {writable.filter((f) => mappedFields.has(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <div id="imp-match-h" className="hint">Rows whose value in this field equals an existing record are treated as duplicates.</div>
            </div>
          )}
          <div className="field">
            <label htmlFor="imp-err">If a row is invalid</label>
            <select id="imp-err" className="select" value={onError} onChange={(e) => setOnError(e.target.value as typeof onError)}>
              <option value="abort">Stop and import nothing</option><option value="skip_rows">Skip invalid rows</option>
            </select>
          </div>
          <label className="row"><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> Validate only (dry run, nothing is written)</label>
          {!dupFree && <div className="err" role="alert">Two columns are mapped to the same field.</div>}

          <div style={{ margin: '10px 0' }}>
            <button className="btn" disabled={busy || mapping().length === 0 || !dupFree} onClick={check}>Check my mapping</button>
            <div aria-live="polite">
              {checked && checked.length === 0 && <p>No problems found in the first {preview.validated_rows} rows.</p>}
              {checked && checked.length > 0 && (
                <table className="table-simple">
                  <caption className="hint" style={{ textAlign: 'left' }}>First {Math.min(checked.length, 20)} problems</caption>
                  <thead><tr><th scope="col">Row</th><th scope="col">Column</th><th scope="col">Problem</th></tr></thead>
                  <tbody>{checked.slice(0, 20).map((e, i) => <tr key={i}><td>{e.row}</td><td>{header(e.column)}</td><td>{e.message}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          </div>
          <div className="row"><span className="spacer" />
            <button className="btn" onClick={() => { setPreview(null); setChecked(null); }}>Back</button>
            <button className="btn primary" disabled={!canRun} onClick={run}>{busy ? 'Starting…' : dry ? 'Validate' : 'Import'}</button>
          </div>
        </div>
      )}

      {step === 3 && job && <JobView job={job} header={header} onCancel={() => jobAction('cancel')} onResume={() => jobAction('resume')} onDownload={downloadErrors} onClose={onClose} />}
    </Dialog>
  );
}

function JobView({ job, header, onCancel, onResume, onDownload, onClose }: { job: Job; header(i?: number): string; onCancel(): void; onResume(): void; onDownload(): void; onClose(): void }) {
  const final = FINAL.has(job.status);
  const total = job.rows_total ?? 0;
  const errs = job.errors ?? [];
  const validateOnly = job.options?.validate_only;
  return (
    <div>
      <div aria-live="polite">
        <p><strong>{final ? ({ done: validateOnly ? 'Validation finished' : 'Import finished', failed: 'Import failed', cancelled: 'Import cancelled' } as Record<string, string>)[job.status] : job.status === 'queued' ? 'Waiting to start…' : 'Importing…'}</strong></p>
        <progress className="progress" aria-label="Import progress" max={total || undefined} value={total ? job.rows_processed : undefined} />
        <div className="hint">{job.rows_processed}{total ? ` of ${total}` : ''} rows processed</div>
      </div>
      <div className="counters">
        <span>Created: {job.rows_created}</span><span>Updated: {job.rows_updated}</span><span>Skipped: {job.rows_skipped}</span><span>Failed: {job.rows_failed}</span>
      </div>
      {job.last_error && <div className="banner error" role="alert">{job.last_error}{/Nothing was imported/.test(job.last_error) && ' Fix the problems in your file and try again, or go back and choose "Skip invalid rows".'}</div>}
      {errs.length > 0 && (
        <div>
          <table className="table-simple">
            <caption className="hint" style={{ textAlign: 'left' }}>Problems found (showing {Math.min(errs.length, 50)} of {errs.length})</caption>
            <thead><tr><th scope="col">Row</th><th scope="col">Column</th><th scope="col">Problem</th></tr></thead>
            <tbody>{errs.slice(0, 50).map((e, i) => <tr key={i}><td>{e.row}</td><td>{header(e.column)}</td><td>{e.message}</td></tr>)}</tbody>
          </table>
          <button className="btn small" style={{ marginTop: 6 }} onClick={onDownload}>Download error report (CSV)</button>
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}><span className="spacer" />
        {!final && <button className="btn" onClick={onCancel}>Cancel import</button>}
        {job.status === 'failed' && <button className="btn" onClick={onResume}>Resume</button>}
        <button className="btn primary" onClick={onClose}>{final ? 'Close' : 'Close (keeps running)'}</button>
      </div>
    </div>
  );
}
