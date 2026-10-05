import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, ErrorState, Spinner, errText, useToast } from '../components/ui';
import { primaryField, andFilter } from '../lib/boardMath';
import { addDays, bucketByDay, instantDayKey, instantRange, monthGrid, shiftMonth, todayKey, zonedWallToInstant, type DayCell } from '../lib/calendarMath';
import { displayValue } from '../lib/format';
import { useRecordMutations, useRecords } from '../lib/queries';
import type { ApiRecord, Field, FilterNode, RecordQuery, ViewProps } from '../types';

const PAGE = 50;
const MAX_EVENTS = 3;
const DATE_TYPES = new Set(['date', 'datetime', 'created_time', 'modified_time']);
const WRITABLE = new Set(['date', 'datetime']);
const END_TYPES = new Set(['date', 'datetime']);

const zoneOf = (f: Field): string | undefined => (typeof f.options.timezone === 'string' && f.options.timezone ? f.options.timezone : undefined);
const HAS_ZONE = /(z|[+-]\d{2}:?\d{2})$/i;

/** Local calendar day of a record for a date-like field, or null when empty. */
export function dayKeyOf(r: ApiRecord, f: Field): string | null {
  let v: unknown = r.fields[f.id];
  if (f.type === 'created_time') v ??= r.created_time;
  if (f.type === 'modified_time') v ??= r.modified_time;
  if (typeof v !== 'string' || !v) return null;
  if (f.type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (!HAS_ZONE.test(v) && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10); // naive wall-clock string
  return instantDayKey(v, zoneOf(f));
}

function bounds(f: Field, from: string, to: string) {
  return f.type === 'date' ? { from, to } : instantRange(from, to, zoneOf(f));
}

export function CalendarView({ table, fields, config, query, canEdit, onOpenRecord, onConfigChange }: ViewProps) {
  const cal = config.calendar;
  const dateField = fields.find((f) => f.id === cal?.dateField && DATE_TYPES.has(f.type));
  const endField = fields.find((f) => f.id === cal?.endDateField && END_TYPES.has(f.type) && f.id !== dateField?.id);
  const primary = primaryField(fields);
  const titleField = fields.find((f) => f.id === cal?.titleField) ?? primary;
  const toast = useToast();
  const { create } = useRecordMutations(table.id);
  const uid = useId();

  const today = todayKey();
  const [ym, setYm] = useState(() => { const t = today.split('-').map(Number); return { year: t[0]!, month: t[1]! }; });
  const [activeKey, setActiveKey] = useState(today);
  const [more, setMore] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const closeMore = useCallback(() => setMore(null), []);

  const cells = useMemo(() => monthGrid(ym.year, ym.month), [ym]);
  const gridStart = cells[0]!.key, gridEnd = cells[cells.length - 1]!.key;
  const active = cells.some((c) => c.key === activeKey) ? activeKey : (cells.find((c) => c.key === today)?.key ?? cells.find((c) => c.inMonth)!.key);

  const rangeQuery = useMemo<RecordQuery>(() => {
    if (!dateField) return query;
    const s = bounds(dateField, gridStart, gridEnd);
    const inRange: FilterNode = { and: [{ field: dateField.id, op: 'gte', value: s.from }, { field: dateField.id, op: 'lte', value: s.to }] };
    let mine: FilterNode = inRange;
    if (endField) {
      // events that began before the grid but are still running inside it
      const e = bounds(endField, gridStart, gridEnd);
      mine = { or: [inRange, { and: [{ field: dateField.id, op: 'lt', value: s.from }, { field: endField.id, op: 'gte', value: e.from }] }] };
    }
    const sort = query.sort?.length ? query.sort : dateField.type === 'date' || dateField.type === 'datetime' ? [{ field: dateField.id, direction: 'asc' as const }] : undefined;
    return { search: query.search, sort, filter: andFilter(query.filter, mine) };
  }, [query, dateField, endField, gridStart, gridEnd]);

  const q = useRecords(table.id, rangeQuery, { pageSize: PAGE, enabled: !!dateField });

  const byDay = useMemo(() => {
    if (!dateField) return new Map<string, ApiRecord[]>();
    const items = [];
    for (const r of q.rows) {
      const start = dayKeyOf(r, dateField);
      if (!start) continue;
      const end = endField ? dayKeyOf(r, endField) ?? start : start;
      items.push({ item: r, start, end });
    }
    return bucketByDay(items, gridStart, gridEnd);
  }, [q.rows, dateField, endField, gridStart, gridEnd]);

  const go = useCallback((delta: number | 'today') => {
    if (delta === 'today') { const t = todayKey(); const [y, m] = t.split('-').map(Number); setYm({ year: y!, month: m! }); setActiveKey(t); return; }
    setYm((cur) => shiftMonth(cur.year, cur.month, delta));
    setActiveKey((k) => { const [y, m, d] = k.split('-').map(Number); const n = shiftMonth(y!, m!, delta); return `${String(n.year).padStart(4, '0')}-${String(n.month).padStart(2, '0')}-${String(Math.min(d!, 28)).padStart(2, '0')}`; });
  }, []);

  useEffect(() => {
    if (refocus.current) { refocus.current = false; gridRef.current?.querySelector<HTMLElement>(`[data-day="${active}"]`)?.focus(); }
  });

  if (!dateField) {
    const opts = fields.filter((f) => DATE_TYPES.has(f.type));
    return (
      <div className="empty">
        <p><strong>Choose a date field to place records on the calendar.</strong></p>
        {opts.length === 0 ? <p>This table has no date or date and time field.</p> : canEdit ? (
          <div style={{ maxWidth: 280, margin: '0 auto', textAlign: 'left' }}>
            <label htmlFor={`${uid}-d`} className="hint">Date field</label>
            <select id={`${uid}-d`} className="select" value="" onChange={(e) => e.target.value && onConfigChange({ calendar: { ...cal, dateField: e.target.value } })}>
              <option value="">Select a field…</option>
              {opts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        ) : <p>Ask someone with edit access to pick a date field.</p>}
      </div>
    );
  }

  const canCreate = canEdit && WRITABLE.has(dateField.type);
  const titleOf = (r: ApiRecord) => (titleField ? displayValue(titleField, r.fields[titleField.id]) : '') || 'Untitled';
  const monthLabel = new Date(Date.UTC(ym.year, ym.month - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const longDay = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }); };
  const dows = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.UTC(2023, 0, 1 + i)); return { short: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), long: d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' }) }; });

  const addOn = async (key: string) => {
    try {
      const value = dateField.type === 'date' ? key
        : zoneOf(dateField) ? `${key}T09:00:00`
        : new Date(zonedWallToInstant(key, 9, 0)).toISOString();
      const values: Record<string, unknown> = { [dateField.id]: value };
      if (primary) values[primary.id] = 'Untitled';
      const rec = await create(values);
      onOpenRecord(rec.id);
    } catch (e) { toast.push('error', errText(e)); }
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (!(e.target as HTMLElement).hasAttribute('data-day')) return;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string | undefined;
    if (e.key in step) next = addDays(active, step[e.key]!);
    else if (e.key === 'Home') next = addDays(active, -cells.find((c) => c.key === active)!.dow);
    else if (e.key === 'End') next = addDays(active, 6 - cells.find((c) => c.key === active)!.dow);
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); refocus.current = true; go(e.key === 'PageUp' ? -1 : 1); return; }
    else if (e.key === 'Enter') { (e.target as HTMLElement).querySelector<HTMLElement>('button')?.focus(); e.preventDefault(); return; }
    if (!next) return;
    e.preventDefault();
    if (next < gridStart || next > gridEnd) {
      // moving past the visible grid pages to the adjacent month
      const [y, m] = next.split('-').map(Number);
      refocus.current = true; setYm({ year: y!, month: m! }); setActiveKey(next);
      return;
    }
    setActiveKey(next); refocus.current = true;
  };

  const rows: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  const moreRecords = more ? byDay.get(more) ?? [] : [];

  return (
    <div className="cal">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button type="button" className="btn" onClick={() => go(-1)} aria-label="Previous month">‹ Prev</button>
        <button type="button" className="btn" onClick={() => go('today')}>Today</button>
        <button type="button" className="btn" onClick={() => go(1)} aria-label="Next month">Next ›</button>
        <h2 className="cal-title" aria-live="polite" aria-atomic="true">{monthLabel}</h2>
        {q.isFetching && <span className="hint" role="status">Loading…</span>}
        <span className="spacer" />
        {canEdit && (
          <label className="row" style={{ gap: 4 }} htmlFor={`${uid}-e`}><span className="hint">End date</span>
            <select id={`${uid}-e`} className="select" style={{ width: 'auto' }} value={endField?.id ?? ''} onChange={(e) => onConfigChange({ calendar: { ...cal!, endDateField: e.target.value || undefined } })}>
              <option value="">None</option>
              {fields.filter((f) => END_TYPES.has(f.type) && f.id !== dateField.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {q.isError && q.rows.length === 0 ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.isPending ? <Spinner label="Loading calendar" /> : (
        <>
          <div className="cal-grid" role="grid" aria-label={`${monthLabel}, by ${dateField.name}`} ref={gridRef} onKeyDown={onGridKey}>
            <div role="row" style={{ display: 'contents' }}>
              {dows.map((d) => <div key={d.long} role="columnheader" className="cal-dow" aria-label={d.long}>{d.short}</div>)}
            </div>
            {rows.map((row, ri) => (
              <div role="row" key={ri} style={{ display: 'contents' }}>
                {row.map((c) => {
                  const evs = byDay.get(c.key) ?? [];
                  const isActive = c.key === active;
                  const ti = isActive ? 0 : -1;
                  return (
                    <div key={c.key} role="gridcell" data-day={c.key} tabIndex={ti} onFocus={() => setActiveKey(c.key)}
                      className={`cal-day${c.inMonth ? '' : ' out'}${c.key === today ? ' today' : ''}`}
                      aria-label={`${longDay(c.key)}, ${evs.length} ${evs.length === 1 ? 'record' : 'records'}${c.key === today ? ', today' : ''}`}>
                      {canCreate
                        ? <button type="button" className="cal-num" tabIndex={ti} aria-label={`Add record on ${longDay(c.key)}`} title="Add record" onClick={() => void addOn(c.key)}><span className="num">{c.day}</span></button>
                        : <span className="cal-num"><span className="num" aria-hidden="true">{c.day}</span></span>}
                      {evs.slice(0, MAX_EVENTS).map((r) => (
                        <button key={r.id} type="button" className="cal-evt" tabIndex={ti} onClick={() => onOpenRecord(r.id)} title={titleOf(r)}>{titleOf(r)}</button>
                      ))}
                      {evs.length > MAX_EVENTS && (
                        <button type="button" className="cal-evt cal-more" tabIndex={ti} onClick={() => setMore(c.key)} aria-haspopup="dialog">+{evs.length - MAX_EVENTS} more</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {byDay.size === 0 && <div className="hint" style={{ padding: 8 }}>No records dated in this month{query.search || query.filter ? ' match the current search or filters' : ''}.</div>}
          {q.hasNextPage && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="hint">More records exist in this range than are loaded.</span>
              <button type="button" className="btn small" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </>
      )}
      {more && (
        <Dialog title={longDay(more)} onClose={closeMore}>
          <ul className="cal-list">
            {moreRecords.map((r) => (
              <li key={r.id}><button type="button" className="btn" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => { setMore(null); onOpenRecord(r.id); }}>{titleOf(r)}</button></li>
            ))}
          </ul>
          <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={closeMore}>Close</button></div>
        </Dialog>
      )}
    </div>
  );
}
