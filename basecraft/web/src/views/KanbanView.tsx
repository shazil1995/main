import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ErrorState, Spinner, errText, useToast } from '../components/ui';
import { CardFieldRows } from '../lib/CardValue';
import { andFilter, cardFieldsFor, primaryField, singleSelectFields, validGroupField } from '../lib/boardMath';
import { colorFor, displayValue, selectOptions } from '../lib/format';
import { useRecordMutations, useRecords } from '../lib/queries';
import type { ApiRecord, Field, RecordQuery, ViewProps } from '../types';

const PAGE = 30;
interface Col { key: string; optionId: string | null; name: string; color?: string }

export function KanbanView(props: ViewProps) {
  const { table, fields, config, query, canEdit, onOpenRecord, onConfigChange } = props;
  const groupField = validGroupField(fields, config);
  const toast = useToast();
  const { updateCell, create, invalidate } = useRecordMutations(table.id);
  const dragged = useRef<ApiRecord | null>(null);
  const pickId = useId();

  const primary = primaryField(fields);
  const cardFields = useMemo(() => cardFieldsFor(fields, config.kanban?.cardFields, config.hiddenFields, 3), [fields, config.kanban?.cardFields, config.hiddenFields]);

  const move = useCallback(async (record: ApiRecord, to: Col | undefined) => {
    if (!groupField || !to) return;
    const cur = (record.fields[groupField.id] as string | undefined) ?? null;
    if (cur === to.optionId) return;
    try {
      await updateCell({ record, fieldId: groupField.id, value: to.optionId });
      await invalidate();
      toast.push('info', `Moved "${titleOf(primary, record)}" to ${to.name}`);
    } catch (e) {
      toast.push('error', errText(e));
      void invalidate();
    }
  }, [groupField, updateCell, invalidate, toast, primary]);

  if (!groupField) {
    const choices = singleSelectFields(fields);
    return (
      <div className="empty">
        <p><strong>Choose a field to group this board by.</strong></p>
        {choices.length === 0 ? (
          <p>This table has no single select field. Add one in the grid view, then come back.</p>
        ) : canEdit ? (
          <div style={{ maxWidth: 280, margin: '0 auto', textAlign: 'left' }}>
            <label htmlFor={pickId} className="hint">Group by (single select field)</label>
            <select id={pickId} className="select" value="" onChange={(e) => e.target.value && onConfigChange({ kanban: { ...config.kanban, groupField: e.target.value } })}>
              <option value="">Select a field…</option>
              {choices.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        ) : <p>Ask someone with edit access to pick a grouping field.</p>}
      </div>
    );
  }

  const cols: Col[] = [
    { key: '__none', optionId: null, name: 'Unassigned' },
    ...selectOptions(groupField).map((o) => ({ key: o.id, optionId: o.id, name: o.name, color: colorFor(o) })),
  ];

  return (
    <div className="board" role="group" aria-label={`Board grouped by ${groupField.name}`}>
      {cols.map((c) => (
        <Column key={c.key} col={c} cols={cols} tableId={table.id} groupField={groupField} primary={primary} cardFields={cardFields}
          query={query} canEdit={canEdit} hideEmpty={!!config.kanban?.hideEmptyColumn} dragged={dragged}
          onOpen={onOpenRecord} onMove={move}
          onAdd={async () => {
            try {
              const values: Record<string, unknown> = { [groupField.id]: c.optionId };
              if (primary) values[primary.id] = 'Untitled';
              if (c.optionId === null) delete values[groupField.id];
              const rec = await create(values);
              onOpenRecord(rec.id);
            } catch (e) { toast.push('error', errText(e)); }
          }} />
      ))}
    </div>
  );
}

const titleOf = (primary: Field | undefined, r: ApiRecord) => (primary ? displayValue(primary, r.fields[primary.id]) : '') || 'Untitled';

interface ColumnProps {
  col: Col; cols: Col[]; tableId: string; groupField: Field; primary?: Field; cardFields: Field[]; query: RecordQuery;
  canEdit: boolean; hideEmpty: boolean; dragged: React.RefObject<ApiRecord | null>;
  onOpen(id: string): void; onMove(r: ApiRecord, to: Col | undefined): void; onAdd(): void;
}

function Column({ col, cols, tableId, groupField, primary, cardFields, query, canEdit, hideEmpty, dragged, onOpen, onMove, onAdd }: ColumnProps) {
  const headId = useId();
  const [over, setOver] = useState(false);
  const colQuery = useMemo<RecordQuery>(() => ({
    search: query.search, sort: query.sort,
    filter: andFilter(query.filter, col.optionId === null ? { field: groupField.id, op: 'is_empty' } : { field: groupField.id, op: 'eq', value: col.optionId }),
  }), [query, groupField.id, col.optionId]);
  const q = useRecords(tableId, colQuery, { pageSize: PAGE, includeTotal: true });

  if (hideEmpty && col.optionId === null && q.isSuccess && q.total === 0) return null;

  const countText = q.total === undefined ? '' : `${q.total}${q.totalCapped ? '+' : ''}`;
  return (
    <section className={`column${over ? ' drop' : ''}`} aria-labelledby={headId}
      onDragOver={canEdit ? (e) => { if (dragged.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } } : undefined}
      onDragLeave={canEdit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); } : undefined}
      onDrop={canEdit ? (e) => { e.preventDefault(); setOver(false); const r = dragged.current; dragged.current = null; if (r) onMove(r, col); } : undefined}>
      <header className="row" style={{ gap: 6 }}>
        {col.color && <span aria-hidden="true" className="col-dot" style={{ background: col.color }} />}
        <h3 id={headId} className="col-title">{col.name}</h3>
        <span className="badge" aria-label={countText ? `${countText} records` : undefined}>{countText || '…'}</span>
        <span className="spacer" />
        {canEdit && <button type="button" className="btn small ghost" onClick={onAdd} aria-label={`Add record to ${col.name}`}>+ Add</button>}
      </header>
      {q.isPending ? <Spinner label="Loading cards" /> : q.isError && q.rows.length === 0 ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
        <div className="cards" role="list" aria-label={`${col.name} cards`}>
          {q.rows.length === 0 && <div className="hint" style={{ padding: 8 }}>{canEdit ? 'No cards. Drop one here or use Add.' : 'No cards.'}</div>}
          {q.rows.map((r) => {
            const title = titleOf(primary, r);
            const cur = (r.fields[groupField.id] as string | undefined) ?? '';
            return (
              <div key={r.id} role="listitem" className="kcard" draggable={canEdit}
                onDragStart={canEdit ? (e) => { dragged.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); } : undefined}
                onDragEnd={() => { dragged.current = null; setOver(false); }}>
                <button type="button" className="kcard-open" onClick={() => onOpen(r.id)} aria-label={`Open ${title}`}>
                  <span className="kcard-title">{title}</span>
                  <CardFieldRows fields={cardFields} values={r.fields} />
                </button>
                {canEdit && (
                  <select className="select kcard-move" value={cur} aria-label={`Move ${title} to column, currently ${cols.find((c) => (c.optionId ?? '') === cur)?.name ?? 'Unassigned'}`} onChange={(e) => onMove(r, cols.find((c) => (c.optionId ?? '') === e.target.value))}>
                    {cols.map((c) => <option key={c.key} value={c.optionId ?? ''}>{c.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
          {q.hasNextPage && <button type="button" className="btn small" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
        </div>
      )}
    </section>
  );
}
