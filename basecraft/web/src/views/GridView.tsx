import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api';
import { CellDisplay } from '../components/CellEditor';
import { Popover, ErrorState, errText, useConfirm, useToast } from '../components/ui';
import { visibleFields } from '../components/ViewControls';
import { copyText, displayValue, fromLocalInput, isReadonly, isTextType, parseCellText, parseTsv, selectOptions, toLocalInput, toTsv } from '../lib/format';
import { isTypingKey, nextPos, pasteTargets, rangeIds } from '../lib/gridNav';
import { useRecordMutations, useRecords } from '../lib/queries';
import type { ApiRecord, Field, RecordQuery, ViewProps } from '../types';

const ROW_H = 34, HEAD_H = 36, GUTTER = 76;
const WIDTHS: Record<string, number> = { text: 220, long_text: 260, integer: 110, decimal: 120, currency: 130, percent: 110, date: 130, datetime: 210, checkbox: 90, single_select: 170, multi_select: 210, email: 220, url: 220, phone: 150, created_time: 190, modified_time: 190, attachment: 200 };
const NUMERIC = new Set(['integer', 'decimal', 'currency', 'percent']);
const widthOf = (f: Field, cfg: ViewProps['config']) => cfg.fieldWidths?.[f.id] ?? WIDTHS[f.type] ?? 160;

type Item = { kind: 'row'; rec: ApiRecord; index: number } | { kind: 'group'; key: string; label: string };
interface Active { recordId: string; fieldId: string }
interface Editing extends Active { initial: string }
interface UndoEntry { edits: { recordId: string; fieldId: string; before: unknown }[] }

export interface GridProps extends ViewProps {
  canDelete: boolean;
  onLoaded(info: { rows: ApiRecord[]; total?: number; capped: boolean }): void;
  onAddRecord(): void;
}

export function GridView(props: GridProps) {
  const { table, fields, config, query, canEdit, canDelete, onOpenRecord, onConfigChange, onLoaded, onAddRecord } = props;
  const toast = useToast();
  const { confirm, node: confirmNode } = useConfirm();
  const cols = useMemo(() => visibleFields(fields, config), [fields, config]);
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);

  // grouping is a leading server-side sort so groups are contiguous across pages
  const effective: RecordQuery = useMemo(() => {
    const g = config.groupBy;
    if (!g) return query;
    return { ...query, sort: [{ field: g, direction: 'asc' as const }, ...(query.sort ?? []).filter((s) => s.field !== g)].slice(0, 4) };
  }, [query, config.groupBy]);
  const rq = useRecords(table.id, effective, { includeTotal: true });
  const { rows } = rq;
  const { updateCell, updateMany, remove } = useRecordMutations(table.id);

  const items: Item[] = useMemo(() => {
    if (!config.groupBy) return rows.map((rec, index) => ({ kind: 'row', rec, index }));
    const gf = fieldById.get(config.groupBy);
    const out: Item[] = []; let last: string | null = null;
    rows.forEach((rec, index) => {
      const v = gf ? displayValue(gf, rec.fields[gf.id]) : '';
      const key = v === '' ? '__empty__' : v;
      if (key !== last) { out.push({ kind: 'group', key: key + ':' + index, label: `${gf?.name ?? 'Group'}: ${v === '' ? '(empty)' : v}` }); last = key; }
      out.push({ kind: 'row', rec, index });
    });
    return out;
  }, [rows, config.groupBy, fieldById]);

  useEffect(() => { onLoaded({ rows, total: rq.total, capped: rq.totalCapped }); }, [rows, rq.total, rq.totalCapped]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{ id: string; width: number } | null>(null);
  const colWidth = useCallback((f: Field) => (resizing?.id === f.id ? resizing.width : widthOf(f, config)), [resizing, config]);
  const colOffsets = useMemo(() => { let x = 0; return cols.map((f) => { const o = x; x += colWidth(f); return o; }); }, [cols, colWidth]);
  const totalW = GUTTER + cols.reduce((a, f) => a + colWidth(f), 0);

  const rowVirt = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 8 });
  const colVirt = useVirtualizer({ horizontal: true, count: cols.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => colWidth(cols[i]!), overscan: 2, paddingStart: GUTTER });
  useEffect(() => { colVirt.measure(); }, [cols, config.fieldWidths, resizing]); // eslint-disable-line react-hooks/exhaustive-deps
  const vRows = rowVirt.getVirtualItems(), vCols = colVirt.getVirtualItems();

  // ── bounded page window: fetch more near either edge and keep the viewport anchored when pages are dropped/prepended ──
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const firstVisible = vRows[0]?.index ?? 0, lastVisible = vRows[vRows.length - 1]?.index ?? 0;
  useEffect(() => {
    const el = scrollRef.current; if (!el || !items.length) return;
    const remember = () => { const it = items[firstVisible]; const v = vRows[0]; if (it && v) anchor.current = { id: it.kind === 'row' ? it.rec.id : it.key, offset: v.start - el.scrollTop }; };
    if (lastVisible >= items.length - 12 && rq.hasNextPage && !rq.isFetchingNextPage) { remember(); void rq.fetchNextPage(); }
    else if (firstVisible <= 4 && rq.hasPreviousPage && !rq.isFetchingPreviousPage && !rq.isFetchingNextPage) { remember(); void rq.fetchPreviousPage(); }
  }, [firstVisible, lastVisible, items.length, rq.hasNextPage, rq.hasPreviousPage, rq.isFetchingNextPage, rq.isFetchingPreviousPage]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const a = anchor.current, el = scrollRef.current; if (!a || !el) return;
    const idx = items.findIndex((it) => (it.kind === 'row' ? it.rec.id : it.key) === a.id);
    if (idx >= 0) { const want = idx * ROW_H - a.offset; if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want; }
    anchor.current = null;
  }, [items]);
  const qKey = JSON.stringify(effective);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [qKey]);

  // ── selection, active cell, editing ──
  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSel = useRef<number>(0);
  const [cellErr, setCellErr] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const undo = useRef<UndoEntry[]>([]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const recById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const rowIdx = useMemo(() => new Map(rowIds.map((id, i) => [id, i])), [rowIds]);
  const colIdx = useMemo(() => new Map(cols.map((f, i) => [f.id, i])), [cols]);
  const itemIndexOfRow = useMemo(() => { const m = new Map<string, number>(); items.forEach((it, i) => { if (it.kind === 'row') m.set(it.rec.id, i); }); return m; }, [items]);

  useEffect(() => { if (active && !recById.has(active.recordId) && rows.length) setActive({ recordId: rows[Math.min(lastActiveRow.current, rows.length - 1)]!.id, fieldId: active.fieldId }); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastActiveRow = useRef(0);
  useEffect(() => { if (active) lastActiveRow.current = rowIdx.get(active.recordId) ?? 0; }, [active, rowIdx]);
  useEffect(() => { setSelected((s) => { const keep = new Set([...s].filter((id) => recById.has(id))); return keep.size === s.size ? s : keep; }); }, [recById]);

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });
  const moveTo = (row: number, col: number) => {
    const rec = rows[row], f = cols[col]; if (!rec || !f) return;
    setActive({ recordId: rec.id, fieldId: f.id });
    const ii = itemIndexOfRow.get(rec.id); if (ii !== undefined) rowVirt.scrollToIndex(ii, { align: 'auto' });
    colVirt.scrollToIndex(col, { align: 'auto' });
  };

  /** Save one cell with optimistic UI, per-cell error state, conflict handling and undo bookkeeping. */
  const saveCell = useCallback(async (rec: ApiRecord, f: Field, value: unknown, recordUndo = true) => {
    const key = `${rec.id}:${f.id}`;
    const before = rec.fields[f.id] ?? null;
    if (JSON.stringify(before) === JSON.stringify(value ?? null)) return true;
    setPending((n) => n + 1); setSaveErr(null); setRetry(null);
    setCellErr(({ [key]: _, ...rest }) => rest);
    try {
      await updateCell({ record: rec, fieldId: f.id, value });
      if (recordUndo) { undo.current.push({ edits: [{ recordId: rec.id, fieldId: f.id, before }] }); if (undo.current.length > 50) undo.current.shift(); }
      return true;
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 422 ? (e.fieldErrors[f.id] ?? e.message) : e instanceof ApiError && e.status === 412 ? `Changed by someone else — their version is shown` : errText(e);
      setCellErr((m) => ({ ...m, [key]: msg }));
      setSaveErr(`${f.name}: ${msg}`);
      if (e instanceof ApiError && e.status === 412) { const server = e.details?.current as ApiRecord | undefined; if (server) setRetry(() => () => { void saveCell(server, f, value); }); }
      return false;
    } finally { setPending((n) => n - 1); }
  }, [updateCell]);

  const startEdit = (rec: ApiRecord, f: Field, typed?: string) => {
    if (!canEdit || isReadonly(f)) return;
    if (f.type === 'checkbox') { void saveCell(rec, f, rec.fields[f.id] === true ? false : true); return; }
    if (f.type === 'long_text' || f.type === 'multi_select') { onOpenRecord(rec.id); return; }
    const v = rec.fields[f.id];
    let initial = typed ?? '';
    if (typed === undefined) initial = f.type === 'datetime' ? (v ? toLocalInput(v as string, f.options.timezone).slice(0, 16) : '') : f.type === 'single_select' ? ((v as string) ?? '') : v === null || v === undefined ? '' : String(v);
    setEditing({ recordId: rec.id, fieldId: f.id, initial });
  };

  const commitEdit = async (text: string, move: 'down' | 'right' | 'left' | 'none') => {
    const ed = editing; if (!ed) return;
    const rec = recById.get(ed.recordId), f = fieldById.get(ed.fieldId);
    setEditing(null);
    if (rec && f) {
      let value: unknown;
      if (f.type === 'datetime') value = text ? fromLocalInput(text, f.options.timezone) : null;
      else if (f.type === 'single_select') value = text || null;
      else {
        const p = parseCellText(f, text);
        if (!p.ok) { setCellErr((m) => ({ ...m, [`${rec.id}:${f.id}`]: p.message })); setSaveErr(`${f.name}: ${p.message}`); focusGrid(); return; }
        value = p.value;
      }
      void saveCell(rec, f, value);
    }
    focusGrid();
    if (move !== 'none' && active) { const r = rowIdx.get(active.recordId) ?? 0, c = colIdx.get(active.fieldId) ?? 0; moveTo(move === 'down' ? Math.min(rows.length - 1, r + 1) : r, move === 'right' ? Math.min(cols.length - 1, c + 1) : move === 'left' ? Math.max(0, c - 1) : c); }
  };

  const doUndo = async () => {
    const entry = undo.current.pop(); if (!entry) { toast.push('info', 'Nothing to undo'); return; }
    try {
      const ops: { id: string; version: number; fields: Record<string, unknown> }[] = [];
      for (const e of entry.edits) { const rec = recById.get(e.recordId); if (!rec) continue; const ex = ops.find((o) => o.id === rec.id); if (ex) ex.fields[e.fieldId] = e.before; else ops.push({ id: rec.id, version: rec.version, fields: { [e.fieldId]: e.before } }); }
      if (ops.length) await updateMany(ops);
      toast.push('info', 'Undid last change');
    } catch (e) { toast.push('error', `Could not undo: ${errText(e)}`); }
  };

  const doPaste = async (text: string) => {
    if (!canEdit || !active) return;
    const block = parseTsv(text);
    if (!block.length) return;
    const start = { row: rowIdx.get(active.recordId) ?? 0, col: colIdx.get(active.fieldId) ?? 0 };
    const t = pasteTargets(start, block, { rows: rows.length, cols: cols.length });
    const problems: string[] = [];
    const byRec = new Map<string, { id: string; version: number; fields: Record<string, unknown>; before: { fieldId: string; before: unknown }[] }>();
    for (const c of t.cells) {
      const rec = rows[c.row]!, f = cols[c.col]!;
      if (isReadonly(f)) { problems.push(`Row ${c.row + 1}, ${f.name}: read-only`); continue; }
      const p = parseCellText(f, c.text);
      if (!p.ok) { problems.push(`Row ${c.row + 1}, ${f.name}: ${p.message}`); continue; }
      const e = byRec.get(rec.id) ?? { id: rec.id, version: rec.version, fields: {}, before: [] };
      e.fields[f.id] = p.value; e.before.push({ fieldId: f.id, before: rec.fields[f.id] ?? null }); byRec.set(rec.id, e);
    }
    if (problems.length) { setSaveErr(`Nothing was pasted. ${problems.length} cell(s) are invalid — ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`); return; }
    const ops = [...byRec.values()];
    if (!ops.length) return;
    setPending((n) => n + 1); setSaveErr(null);
    try {
      for (let i = 0; i < ops.length; i += 100) await updateMany(ops.slice(i, i + 100).map(({ id, version, fields }) => ({ id, version, fields })));
      undo.current.push({ edits: ops.flatMap((o) => o.before.map((b) => ({ recordId: o.id, ...b }))) });
      toast.push('info', `Pasted ${t.cells.length} cell(s)${t.clippedRows || t.clippedCols ? ` — ${t.clippedRows} row(s) and ${t.clippedCols} column(s) beyond the loaded grid were ignored` : ''}`);
    } catch (e) { setSaveErr(e instanceof ApiError && e.status === 412 ? 'Some rows were changed by someone else; nothing was pasted. Retry.' : `Paste failed, nothing was applied: ${errText(e)}`); }
    finally { setPending((n) => n - 1); }
  };

  const copy = (e: React.ClipboardEvent) => {
    if (editing) return;
    let tsv = '';
    if (selected.size) tsv = toTsv(rows.filter((r) => selected.has(r.id)).map((r) => cols.map((f) => copyText(f, r.fields[f.id]))));
    else if (active) { const r = recById.get(active.recordId), f = fieldById.get(active.fieldId); if (r && f) tsv = copyText(f, r.fields[f.id]); }
    else return;
    e.clipboardData.setData('text/plain', tsv); e.preventDefault();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    if ((e.target as HTMLElement).closest('.popover, .cell-edit, button, input, select')) { if (!(e.target as HTMLElement).classList.contains('grid-scroll')) return; }
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    if (mods.ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); void doUndo(); return; }
    if (mods.ctrl) { if (['c', 'v', 'x'].includes(e.key.toLowerCase())) return; }
    if (!rows.length || !cols.length) return;
    const cur = active ?? { recordId: rows[0]!.id, fieldId: cols[0]!.id };
    const pos = { row: rowIdx.get(cur.recordId) ?? 0, col: colIdx.get(cur.fieldId) ?? 0 };
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 2);
    const np = nextPos(pos, e.key, { rows: rows.length, cols: cols.length, page }, mods);
    if (np) { e.preventDefault(); if (!active) setActive(cur); moveTo(np.row, np.col); return; }
    const rec = recById.get(cur.recordId), f = fieldById.get(cur.fieldId);
    if (!rec || !f) return;
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); if (e.shiftKey && e.key === 'Enter') { onOpenRecord(rec.id); return; } startEdit(rec, f); return; }
    if (e.key === ' ' && e.shiftKey) { e.preventDefault(); onOpenRecord(rec.id); return; }
    if (e.key === ' ' && f.type === 'checkbox') { e.preventDefault(); startEdit(rec, f); return; }
    if (e.key === ' ') { e.preventDefault(); toggleSel(rec.id, rowIdx.get(rec.id) ?? 0, false); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit && !isReadonly(f)) { e.preventDefault(); void saveCell(rec, f, null); return; }
    if (e.key === 'Escape') { setSelected(new Set()); setSaveErr(null); return; }
    if (isTypingKey(e) && canEdit && !isReadonly(f) && (isTextType(f.type) || NUMERIC.has(f.type) || f.type === 'single_select' || f.type === 'date' || f.type === 'datetime')) {
      if (f.type === 'single_select' || f.type === 'date' || f.type === 'datetime') { e.preventDefault(); startEdit(rec, f); return; }
      e.preventDefault(); startEdit(rec, f, e.key);
    }
  };

  const toggleSel = (id: string, index: number, shift: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      if (shift && s.size) for (const x of rangeIds(rowIds, lastSel.current, index)) n.add(x);
      else if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    lastSel.current = index;
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;

  const deleteSelected = async () => {
    const recs = rows.filter((r) => selected.has(r.id));
    if (!recs.length || !(await confirm(`Delete ${recs.length} record${recs.length === 1 ? '' : 's'}? This cannot be undone.`))) return;
    try {
      for (let i = 0; i < recs.length; i += 100) await remove(recs.slice(i, i + 100).map((r) => ({ id: r.id, version: r.version })));
      setSelected(new Set()); toast.push('info', `Deleted ${recs.length} record(s)`); undo.current = [];
    } catch (e) { toast.push('error', e instanceof ApiError && e.status === 412 ? 'Some records were changed by someone else. Nothing was deleted; the grid has been refreshed.' : errText(e)); void rq.refetch(); }
  };

  // header actions
  const sortOf = (id: string) => query.sort?.find((s) => s.field === id)?.direction;
  const setSort = (id: string, dir: 'asc' | 'desc' | null) => onConfigChange({ sort: dir ? [{ field: id, direction: dir }] : (query.sort ?? []).filter((s) => s.field !== id) });
  const startResize = (e: React.PointerEvent, f: Field) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = colWidth(f); let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(60, Math.min(900, w0 + ev.clientX - x0)); setResizing({ id: f.id, width: w }); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setResizing(null); onConfigChange({ fieldWidths: { ...(config.fieldWidths ?? {}), [f.id]: w } }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  if (rq.isLoading && !rows.length) return <div className="empty" role="status"><div className="skeleton" style={{ width: 240, margin: '0 auto 8px' }} />Loading records…</div>;
  if (rq.error && !rows.length) return <ErrorState error={rq.error} retry={() => void rq.refetch()} />;

  const activeCellId = active ? `cell-${active.recordId}-${active.fieldId}` : undefined;
  const saveState = pending > 0 ? 'saving' : saveErr ? 'error' : 'saved';
  const filtered = !!(query.filter || query.search);

  return (
    <>
      {selected.size > 0 && (
        <div className="banner" role="region" aria-label="Bulk actions" style={{ margin: 0, borderRadius: 0 }}>
          <span className="row"><strong>{selected.size} selected</strong>
            {canDelete && <button className="btn small danger" onClick={deleteSelected}>Delete</button>}
            <button className="btn small" onClick={() => setSelected(new Set())}>Clear selection</button>
            <span className="hint">Selection covers loaded rows only. Ctrl+C copies them as TSV.</span></span>
        </div>
      )}
      <div
        className="grid-scroll" ref={scrollRef} tabIndex={0} role="grid" aria-label={`${table.name} records`} aria-rowcount={(rq.total ?? rows.length) + 1} aria-colcount={cols.length + 1}
        aria-activedescendant={activeCellId} aria-multiselectable="true" onKeyDown={onKeyDown} onCopy={copy}
        onPaste={(e) => { if (editing) return; e.preventDefault(); void doPaste(e.clipboardData.getData('text/plain')); }}
        onFocus={(e) => { if (e.target === e.currentTarget && !active && rows[0] && cols[0]) setActive({ recordId: rows[0].id, fieldId: cols[0].id }); }}
      >
        <div style={{ width: totalW, position: 'relative', height: HEAD_H + rowVirt.getTotalSize() }}>
          <div className="grid-head" role="row" aria-rowindex={1} style={{ width: totalW }}>
            <div className="gutter" role="columnheader" style={{ width: GUTTER, position: 'sticky', left: 0, zIndex: 7, background: 'var(--panel-2)' }}>
              <input type="checkbox" aria-label="Select all loaded rows" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rowIds))} />
            </div>
            {vCols.map((vc) => {
              const f = cols[vc.index]!; const dir = sortOf(f.id);
              return (
                <div key={f.id} className="ghead" role="columnheader" aria-colindex={vc.index + 2} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} style={{ position: 'absolute', left: colOffsets[vc.index]! + GUTTER, width: colWidth(f), height: HEAD_H }}>
                  <button className="name" title={`${f.name} — click to sort`} onClick={() => setSort(f.id, dir === 'asc' ? 'desc' : dir === 'desc' ? null : 'asc')}>{f.name}{dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}</button>
                  <HeaderMenu field={f} onSort={(d) => setSort(f.id, d)} onHide={() => onConfigChange({ hiddenFields: [...(config.hiddenFields ?? []), f.id] })} onGroup={() => onConfigChange({ groupBy: config.groupBy === f.id ? undefined : f.id })} grouped={config.groupBy === f.id} />
                  <div className={`resizer${resizing?.id === f.id ? ' dragging' : ''}`} onPointerDown={(e) => startResize(e, f)} role="separator" aria-orientation="vertical" aria-label={`Resize ${f.name}`} />
                </div>
              );
            })}
          </div>
          {vRows.map((vr) => {
            const it = items[vr.index]; if (!it) return null;
            if (it.kind === 'group') return <div key={it.key} className="grid-row" role="row" style={{ transform: `translateY(${HEAD_H + vr.start}px)`, width: totalW, background: 'var(--panel-2)', fontWeight: 600 }}><div style={{ position: 'sticky', left: 0, padding: '0 12px', display: 'flex', alignItems: 'center' }}>{it.label}</div></div>;
            const rec = it.rec;
            return (
              <GridRow key={rec.id} rec={rec} rowIndex={it.index} top={HEAD_H + vr.start} totalW={totalW} cols={cols} vCols={vCols} colOffsets={colOffsets} colWidth={colWidth}
                selected={selected.has(rec.id)} activeFieldId={active?.recordId === rec.id ? active.fieldId : undefined} editing={editing?.recordId === rec.id ? editing : undefined}
                errors={cellErr} canEdit={canEdit}
                onToggleSel={(shift) => toggleSel(rec.id, it.index, shift)} onOpen={() => onOpenRecord(rec.id)}
                onActivate={(fid) => { setActive({ recordId: rec.id, fieldId: fid }); focusGrid(); }}
                onStartEdit={(f) => startEdit(rec, f)} onToggleCheck={(f) => { setActive({ recordId: rec.id, fieldId: f.id }); void saveCell(rec, f, rec.fields[f.id] === true ? false : true); }}
                onCommit={commitEdit} onCancel={() => { setEditing(null); focusGrid(); }} />
            );
          })}
        </div>
        {!rows.length && !rq.isFetching && (
          <div className="empty" style={{ position: 'absolute', top: HEAD_H + 20, left: 0, right: 0 }}>
            {filtered ? 'No records match the current search or filters.' : <>No records yet.{canEdit && <> <button className="btn small primary" onClick={onAddRecord}>+ Add the first record</button></>}</>}
          </div>
        )}
      </div>
      {canEdit && <div className="add-row"><button className="btn small" onClick={onAddRecord}>+ Add record</button> <span className="hint">Enter edits · Shift+Space opens the record · Ctrl+Z undoes · paste spreadsheet cells with Ctrl+V</span></div>}
      <div className="statusbar" role="status" aria-live="polite">
        <span>{rows.length.toLocaleString()} loaded{rq.total !== undefined && <> of {rq.total.toLocaleString()}{rq.totalCapped ? '+' : ''}</>} record{(rq.total ?? rows.length) === 1 ? '' : 's'}{rq.isFetchingNextPage || rq.isFetchingPreviousPage ? ' · loading more…' : ''}</span>
        <span className="save-state" data-state={saveState}>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'All changes saved'}</span>
        {saveErr && <span className="err" role="alert">{saveErr} {retry && <button className="btn small" onClick={() => { retry(); setSaveErr(null); }}>Re-apply my change</button>} <button className="btn small ghost" onClick={() => { setSaveErr(null); setRetry(null); }}>Dismiss</button></span>}
        {rq.error && rows.length > 0 && <span className="err">Could not refresh: {errText(rq.error)}</span>}
      </div>
      {confirmNode}
    </>
  );
}

function HeaderMenu({ field, onSort, onHide, onGroup, grouped }: { field: Field; onSort(d: 'asc' | 'desc' | null): void; onHide(): void; onGroup(): void; grouped: boolean }) {
  const sortable = field.type !== 'attachment' && field.type !== 'multi_select';
  return (
    <Popover buttonClass="expand-btn" label={<span aria-label={`${field.name} menu`}>▾</span>}>
      {(close) => (
        <div style={{ display: 'grid', gap: 2, minWidth: 180 }}>
          {sortable && <><button className="btn ghost small" onClick={() => { onSort('asc'); close(); }}>Sort ascending</button><button className="btn ghost small" onClick={() => { onSort('desc'); close(); }}>Sort descending</button></>}
          {sortable && <button className="btn ghost small" onClick={() => { onGroup(); close(); }}>{grouped ? 'Remove grouping' : 'Group by this field'}</button>}
          {!field.is_primary && <button className="btn ghost small" onClick={() => { onHide(); close(); }}>Hide field</button>}
        </div>
      )}
    </Popover>
  );
}

interface RowProps {
  rec: ApiRecord; rowIndex: number; top: number; totalW: number; cols: Field[]; vCols: { index: number }[]; colOffsets: number[]; colWidth(f: Field): number;
  selected: boolean; activeFieldId?: string; editing?: Editing; errors: Record<string, string>; canEdit: boolean;
  onToggleSel(shift: boolean): void; onOpen(): void; onActivate(fieldId: string): void; onStartEdit(f: Field): void; onToggleCheck(f: Field): void;
  onCommit(text: string, move: 'down' | 'right' | 'left' | 'none'): void; onCancel(): void;
}

const GridRow = memo(function GridRow(p: RowProps) {
  const { rec } = p;
  return (
    <div className="grid-row" role="row" aria-rowindex={p.rowIndex + 2} aria-selected={p.selected} style={{ transform: `translateY(${p.top}px)`, width: p.totalW }}>
      <div className="gutter" role="rowheader" style={{ width: GUTTER, position: 'sticky', left: 0, zIndex: 4, background: 'inherit' }}>
        <input type="checkbox" aria-label={`Select row ${p.rowIndex + 1}`} checked={p.selected} onChange={() => {}} onClick={(e) => p.onToggleSel(e.shiftKey)} />
        <span className="muted" style={{ fontSize: 11, minWidth: 18, textAlign: 'right' }}>{p.rowIndex + 1}</span>
        <button className="expand-btn" aria-label={`Open record ${p.rowIndex + 1}`} title="Open record (Shift+Space)" onClick={p.onOpen}>⤢</button>
      </div>
      {p.vCols.map((vc) => {
        const f = p.cols[vc.index]!;
        const isActive = p.activeFieldId === f.id;
        const isEditing = p.editing?.fieldId === f.id;
        const err = p.errors[`${rec.id}:${f.id}`];
        const v = f.type === 'created_time' ? rec.created_time : f.type === 'modified_time' ? rec.modified_time : rec.fields[f.id];
        return (
          <div key={f.id} id={`cell-${rec.id}-${f.id}`} role="gridcell" aria-colindex={vc.index + 2} aria-selected={isActive} aria-readonly={isReadonly(f) || !p.canEdit || undefined} aria-invalid={err ? true : undefined}
            title={err}
            className={`gcell${isActive ? ' active' : ''}${NUMERIC.has(f.type) ? ' num' : ''}${err ? ' invalid' : ''}${isReadonly(f) ? ' ro' : ''}`}
            style={{ position: 'absolute', left: p.colOffsets[vc.index]! + GUTTER, width: p.colWidth(f) }}
            onMouseDown={() => p.onActivate(f.id)} onDoubleClick={() => p.onStartEdit(f)}>
            {isEditing ? <InlineEditor field={f} initial={p.editing!.initial} onCommit={p.onCommit} onCancel={p.onCancel} />
              : f.type === 'checkbox' ? <button className="expand-btn" role="checkbox" aria-checked={v === true ? 'true' : v === false ? 'false' : 'mixed'} aria-label={f.name} tabIndex={-1} disabled={!p.canEdit} onClick={() => p.onToggleCheck(f)} style={{ fontSize: 15 }}>{v === true ? '☑' : v === false ? '☒' : '☐'}</button>
              : f.type === 'single_select' || f.type === 'multi_select' ? <CellDisplay field={f} value={v} />
              : <span className="txt">{displayValue(f, v)}</span>}
          </div>
        );
      })}
    </div>
  );
}, (a, b) => a.rec === b.rec && a.rowIndex === b.rowIndex && a.top === b.top && a.totalW === b.totalW && a.selected === b.selected && a.activeFieldId === b.activeFieldId && a.editing === b.editing
  && a.cols === b.cols && a.canEdit === b.canEdit && a.vCols.length === b.vCols.length && a.vCols.every((c, i) => c.index === b.vCols[i]!.index) && a.colOffsets === b.colOffsets
  && a.errors === b.errors);

function InlineEditor({ field, initial, onCommit, onCancel }: { field: Field; initial: string; onCommit(text: string, move: 'down' | 'right' | 'left' | 'none'): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const [val, setVal] = useState(initial);
  const done = useRef(false);
  useEffect(() => { const el = ref.current; if (!el) return; el.focus(); if (el instanceof HTMLInputElement && initial === '') el.select(); else if (el instanceof HTMLInputElement) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* date inputs */ } } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = (move: 'down' | 'right' | 'left' | 'none', text = val) => { if (done.current) return; done.current = true; onCommit(text, move); };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(e.shiftKey ? 'none' : 'down'); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); finish(e.shiftKey ? 'left' : 'right'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel(); }
    else e.stopPropagation();
  };
  const label = `Edit ${field.name}`;
  if (field.type === 'single_select')
    return <select ref={ref} className="cell-edit" aria-label={label} value={val} onChange={(e) => { setVal(e.target.value); finish('none', e.target.value); }} onKeyDown={keys} onBlur={() => finish('none')}><option value="">—</option>{selectOptions(field).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
  const type = field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text';
  return <input ref={ref} className="cell-edit" aria-label={label} type={type} inputMode={NUMERIC.has(field.type) ? 'decimal' : undefined} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={keys} onBlur={() => finish('none')} />;
}
