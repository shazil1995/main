import { useId, useMemo } from 'react';
import { ErrorState, Spinner } from '../components/ui';
import { CardFieldRows } from '../lib/CardValue';
import { cardFieldsFor, primaryField } from '../lib/boardMath';
import { displayValue } from '../lib/format';
import { useRecords } from '../lib/queries';
import type { ViewProps } from '../types';

const PAGE = 30;

export function GalleryView({ table, fields, config, query, canEdit, onOpenRecord, onConfigChange }: ViewProps) {
  const g = config.gallery ?? {};
  const uid = useId();
  const primary = primaryField(fields);
  const titleField = fields.find((f) => f.id === g.titleField) ?? primary;
  const coverField = fields.find((f) => f.id === g.coverField && f.type === 'attachment');
  const cardFields = useMemo(() => cardFieldsFor(fields, g.cardFields, config.hiddenFields, 4).filter((f) => f.id !== titleField?.id && f.id !== coverField?.id),
    [fields, g.cardFields, config.hiddenFields, titleField?.id, coverField?.id]);
  const q = useRecords(table.id, query, { pageSize: PAGE });
  const sorted = useMemo(() => [...fields].sort((a, b) => a.position - b.position), [fields]);
  const set = (patch: Partial<NonNullable<typeof config.gallery>>) => onConfigChange({ gallery: { ...g, ...patch } });
  const selected = new Set(g.cardFields ?? cardFieldsFor(fields, undefined, config.hiddenFields, 4).map((f) => f.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {canEdit && (
        <div className="row wrap view-settings" role="group" aria-label="Gallery settings">
          <label className="row" style={{ gap: 4 }} htmlFor={`${uid}-t`}><span className="hint">Title</span>
            <select id={`${uid}-t`} className="select" style={{ width: 'auto' }} value={g.titleField ?? ''} onChange={(e) => set({ titleField: e.target.value || undefined })}>
              <option value="">Primary field</option>
              {sorted.filter((f) => f.type !== 'attachment').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="row" style={{ gap: 4 }} htmlFor={`${uid}-c`}><span className="hint">Cover</span>
            <select id={`${uid}-c`} className="select" style={{ width: 'auto' }} value={g.coverField ?? ''} onChange={(e) => set({ coverField: e.target.value || undefined })}>
              <option value="">None</option>
              {sorted.filter((f) => f.type === 'attachment').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <details className="field-pick">
            <summary className="btn small">Card fields ({selected.size})</summary>
            <fieldset className="popover" style={{ position: 'absolute', zIndex: 20, padding: 10 }}>
              <legend className="sr-only">Fields shown on cards (up to 4)</legend>
              {sorted.filter((f) => f.id !== titleField?.id).map((f) => {
                const on = selected.has(f.id);
                return (
                  <label key={f.id} className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={on} disabled={!on && selected.size >= 4}
                      onChange={() => set({ cardFields: (on ? [...selected].filter((x) => x !== f.id) : [...selected, f.id]) })} />
                    {f.name}
                  </label>
                );
              })}
            </fieldset>
          </details>
        </div>
      )}
      {q.isPending ? <Spinner label="Loading records" /> : q.isError && q.rows.length === 0 ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.rows.length === 0 ? (
        <div className="empty">{query.search || query.filter ? 'No records match the current search or filters.' : 'No records yet.'}</div>
      ) : (
        <div className="gallery-scroll" style={{ overflow: 'auto', flex: 1 }}>
          <div className="gallery" role="list" aria-label="Records" style={{ overflow: 'visible' }}>
            {q.rows.map((r) => {
              const title = (titleField ? displayValue(titleField, r.fields[titleField.id]) : '') || 'Untitled';
              const files = coverField && Array.isArray(r.fields[coverField.id]) ? (r.fields[coverField.id] as { filename?: string }[]) : [];
              return (
                <div key={r.id} role="listitem">
                  <button type="button" className="gcard" onClick={() => onOpenRecord(r.id)} aria-label={`Open ${title}`}>
                    {coverField && (
                      <span className="cover">
                        {files.length ? <span className="cover-file"><span aria-hidden="true">📎 </span>{files[0]!.filename ?? 'File'}{files.length > 1 ? ` (+${files.length - 1})` : ''}</span> : <span>No file</span>}
                      </span>
                    )}
                    <span className="body">
                      <span className="gcard-title">{title}</span>
                      <CardFieldRows fields={cardFields} values={r.fields} />
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {q.hasNextPage && (
            <div style={{ textAlign: 'center', padding: 12 }}>
              <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
