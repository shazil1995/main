import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from '../api';
import { AttachmentCell, CellEditor } from './CellEditor';
import { errText, useConfirm, useToast } from './ui';
import { isReadonly } from '../lib/format';
import { qk, useRecord, useRecordMutations } from '../lib/queries';
import type { ApiRecord, Field } from '../types';

interface Comment { id: string; body: string; created_at: string; author_name: string }

/** Side panel with every field of one record. Each field saves on commit with the record's version (optimistic concurrency). */
export function RecordPanel({ tableId, recordId, fields, canEdit, canComment, canDelete, onClose, onNavigate, neighbors }: {
  tableId: string; recordId: string; fields: Field[]; canEdit: boolean; canComment: boolean; canDelete: boolean; onClose(): void; onNavigate(id: string): void; neighbors: { prev?: string; next?: string };
}) {
  const rec = useRecord(recordId);
  const qc = useQueryClient();
  const toast = useToast();
  const { updateCell, remove } = useRecordMutations(tableId);
  const { confirm, node } = useConfirm();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<{ field: string; mine: unknown } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setDraft({}); setErrors({}); setConflict(null); }, [recordId]);
  useEffect(() => { ref.current?.focus(); }, [recordId]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus?.(); };
  }, []);

  if (rec.isLoading) return <PanelShell onClose={onClose} title="Record"><div className="skeleton" style={{ margin: 16 }} /></PanelShell>;
  if (rec.error || !rec.data) return <PanelShell onClose={onClose} title="Record"><div className="banner error" role="alert">{errText(rec.error ?? new Error('Record not found'))} <button className="btn small" onClick={onClose}>Close</button></div></PanelShell>;
  const r = rec.data;
  const primary = fields.find((f) => f.is_primary);
  const title = String(r.fields[primary?.id ?? ''] ?? 'Untitled record');

  const commit = async (f: Field) => {
    if (!(f.id in draft) || isReadonly(f)) return;
    const value = draft[f.id];
    const cur = r.fields[f.id] ?? null;
    if (JSON.stringify(value ?? null) === JSON.stringify(cur)) { setDraft(({ [f.id]: _, ...rest }) => rest); return; }
    setSaving(f.id); setErrors(({ [f.id]: _, ...rest }) => rest);
    try {
      await updateCell({ record: r, fieldId: f.id, value: value ?? null });
      setDraft(({ [f.id]: _, ...rest }) => rest);
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) { setConflict({ field: f.id, mine: value }); await qc.invalidateQueries({ queryKey: qk.record(r.id) }); }
      else if (e instanceof ApiError && e.status === 422) setErrors({ ...errors, ...e.fieldErrors, ...(Object.keys(e.fieldErrors).length ? {} : { [f.id]: e.message }) });
      else setErrors({ ...errors, [f.id]: errText(e) });
    } finally { setSaving(null); }
  };
  const del = async () => {
    if (!(await confirm(`Delete “${title}”? This cannot be undone.`))) return;
    try { await remove([{ id: r.id, version: r.version }]); toast.push('info', 'Record deleted'); onClose(); } catch (e) { toast.push('error', errText(e)); }
  };

  return (
    <PanelShell onClose={onClose} title={title} panelRef={ref} extra={<>
      <button className="btn small" aria-label="Previous record" disabled={!neighbors.prev} onClick={() => neighbors.prev && onNavigate(neighbors.prev)}>↑</button>
      <button className="btn small" aria-label="Next record" disabled={!neighbors.next} onClick={() => neighbors.next && onNavigate(neighbors.next)}>↓</button>
    </>}>
      {conflict && (
        <div className="banner warn" role="alert">
          Someone else changed this record while you were editing. Their version is now shown.
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small primary" onClick={async () => { const c = conflict; setConflict(null); setDraft({ [c.field]: c.mine }); const fresh = await get<ApiRecord>(`/records/${r.id}`); try { await updateCell({ record: fresh, fieldId: c.field, value: c.mine }); setDraft({}); } catch (e) { toast.push('error', errText(e)); } }}>Re-apply my change</button>
            <button className="btn small" onClick={() => { setConflict(null); setDraft({}); }}>Keep theirs</button>
          </div>
        </div>
      )}
      {fields.map((f) => {
        const id = `rp-${f.id}`;
        const val = f.id in draft ? draft[f.id] : r.fields[f.id];
        return (
          <div className="field" key={f.id}>
            <label htmlFor={id}>{f.name}{f.is_primary ? ' (primary)' : ''} <span className="hint">· {f.type.replace('_', ' ')}{saving === f.id ? ' · saving…' : ''}</span></label>
            {f.type === 'attachment'
              ? <AttachmentCell record={r} field={f} canEdit={canEdit} onChanged={() => { qc.invalidateQueries({ queryKey: qk.record(r.id) }); qc.invalidateQueries({ queryKey: qk.recordsAll(tableId) }); }} />
              : <CellEditor id={id} field={f} value={val} disabled={!canEdit || isReadonly(f)} invalid={!!errors[f.id]} onChange={(v) => setDraft({ ...draft, [f.id]: v })} onCommit={() => commit(f)} />}
            {errors[f.id] && <div className="err" role="alert">{errors[f.id]}</div>}
          </div>
        );
      })}
      <div className="hint" style={{ margin: '8px 0' }}>Version {r.version} · created {new Date(r.created_time).toLocaleString()} · modified {new Date(r.modified_time).toLocaleString()}</div>
      {canDelete && <button className="btn danger" onClick={del}>Delete record</button>}
      <Comments recordId={r.id} canComment={canComment} />
      {node}
    </PanelShell>
  );
}

function PanelShell({ title, onClose, children, extra, panelRef }: { title: string; onClose(): void; children: React.ReactNode; extra?: React.ReactNode; panelRef?: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="panel-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label={`Record: ${title}`} ref={panelRef} tabIndex={-1}>
        <div className="panel-head"><strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>{extra}<button className="btn small" onClick={onClose} aria-label="Close record">✕</button></div>
        <div className="panel-body">{children}</div>
      </aside>
    </div>
  );
}

function Comments({ recordId, canComment }: { recordId: string; canComment: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['comments', recordId], queryFn: async () => (await get<{ comments: Comment[] }>(`/records/${recordId}/comments`)).comments });
  const [text, setText] = useState('');
  return (
    <section aria-label="Comments" style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 14 }}>Comments</h3>
      {q.data?.length === 0 && <div className="hint">No comments yet.</div>}
      <ul style={{ listStyle: 'none', padding: 0 }}>{q.data?.map((c) => <li key={c.id} className="card" style={{ marginBottom: 6, padding: 8 }}><strong>{c.author_name}</strong> <span className="hint">{new Date(c.created_at).toLocaleString()}</span><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></li>)}</ul>
      {canComment && (
        <form onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; try { await post(`/records/${recordId}/comments`, { body: text }); setText(''); qc.invalidateQueries({ queryKey: ['comments', recordId] }); } catch (x) { toast.push('error', errText(x)); } }}>
          <label className="sr-only" htmlFor="new-comment">Add a comment</label>
          <textarea id="new-comment" className="textarea" placeholder="Add a comment…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn small primary" style={{ marginTop: 6 }} disabled={!text.trim()}>Comment</button>
        </form>
      )}
    </section>
  );
}
