import { describe, expect, it } from 'vitest';
import { isTypingKey, nextPos, pasteTargets, rangeIds } from './gridNav';
import { parseCellText, parseTsv, toTsv, displayValue, formatMoney, toLocalInput, fromLocalInput } from './format';
import type { Field } from '../types';

const d = { rows: 10, cols: 4, page: 5 };
describe('grid keyboard navigation', () => {
  it('moves and clamps at the edges', () => {
    expect(nextPos({ row: 0, col: 0 }, 'ArrowUp', d)).toEqual({ row: 0, col: 0 });
    expect(nextPos({ row: 0, col: 0 }, 'ArrowDown', d)).toEqual({ row: 1, col: 0 });
    expect(nextPos({ row: 9, col: 3 }, 'ArrowRight', d)).toEqual({ row: 9, col: 3 });
    expect(nextPos({ row: 3, col: 1 }, 'ArrowLeft', d, { ctrl: true })).toEqual({ row: 3, col: 0 });
    expect(nextPos({ row: 3, col: 1 }, 'ArrowDown', d, { ctrl: true })).toEqual({ row: 9, col: 1 });
  });
  it('Tab wraps across rows both ways', () => {
    expect(nextPos({ row: 2, col: 3 }, 'Tab', d)).toEqual({ row: 3, col: 0 });
    expect(nextPos({ row: 2, col: 0 }, 'Tab', d, { shift: true })).toEqual({ row: 1, col: 3 });
    expect(nextPos({ row: 9, col: 3 }, 'Tab', d)).toEqual({ row: 9, col: 3 });
  });
  it('pages, home and end', () => {
    expect(nextPos({ row: 7, col: 2 }, 'PageDown', d)).toEqual({ row: 9, col: 2 });
    expect(nextPos({ row: 3, col: 2 }, 'PageUp', d)).toEqual({ row: 0, col: 2 });
    expect(nextPos({ row: 4, col: 2 }, 'Home', d)).toEqual({ row: 4, col: 0 });
    expect(nextPos({ row: 4, col: 2 }, 'End', d, { ctrl: true })).toEqual({ row: 9, col: 3 });
    expect(nextPos({ row: 1, col: 1 }, 'x', d)).toBeNull();
    expect(nextPos({ row: 0, col: 0 }, 'ArrowDown', { rows: 0, cols: 3, page: 5 })).toBeNull();
  });
  it('distinguishes typing from shortcuts', () => {
    expect(isTypingKey({ key: 'a' })).toBe(true);
    expect(isTypingKey({ key: 'c', ctrlKey: true })).toBe(false);
    expect(isTypingKey({ key: 'Enter' })).toBe(false);
  });
  it('selects ranges in either direction', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(rangeIds(ids, 1, 3)).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 3, 1)).toEqual(['b', 'c', 'd']);
  });
  it('clips pasted blocks to the loaded grid and reports what was cut', () => {
    const r = pasteTargets({ row: 8, col: 2 }, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], { rows: 10, cols: 4 });
    expect(r.cells).toHaveLength(4);
    expect(r.clippedRows).toBe(1); expect(r.clippedCols).toBe(1);
  });
});

const F = (type: string, options: any = {}): Field => ({ id: 'f', name: 'F', type: type as any, options, position: 0, is_primary: false, indexed: false });
describe('cell parsing and display', () => {
  it('keeps false and 0 distinct from empty', () => {
    expect(parseCellText(F('checkbox'), 'no')).toEqual({ ok: true, value: false });
    expect(parseCellText(F('checkbox'), '')).toEqual({ ok: true, value: null });
    expect(parseCellText(F('integer'), '0')).toEqual({ ok: true, value: 0 });
    expect(parseCellText(F('integer'), '1,200')).toEqual({ ok: true, value: 1200 });
    expect(parseCellText(F('integer'), '1.5').ok).toBe(false);
    expect(displayValue(F('checkbox'), false)).toBe('✗');
    expect(displayValue(F('integer'), 0)).toBe('0');
    expect(displayValue(F('integer'), null)).toBe('');
  });
  it('treats money as a string, never a float', () => {
    expect(parseCellText(F('currency'), '$1,299.50')).toEqual({ ok: true, value: '1299.50' });
    expect(formatMoney('1299.50', 'USD')).toBe('$1,299.50');
    expect(formatMoney('-1234567.8', 'USD')).toBe('-$1,234,567.8');
    expect(parseCellText(F('percent'), '12.5%')).toEqual({ ok: true, value: '12.5' });
  });
  it('maps select names to option ids and rejects unknown ones', () => {
    const f = F('single_select', { options: [{ id: 'o1', name: 'Open' }, { id: 'o2', name: 'Closed' }] });
    expect(parseCellText(f, 'closed')).toEqual({ ok: true, value: 'o2' });
    expect(parseCellText(f, 'nope').ok).toBe(false);
    const m = F('multi_select', { options: [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }] });
    expect(parseCellText(m, 'a; b')).toEqual({ ok: true, value: ['o1', 'o2'] });
  });
  it('round-trips TSV with quotes and newlines', () => {
    const rows = [['a', 'b\tc', 'd"e'], ['multi\nline', '', 'x']];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
    expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([['1', '2'], ['3', '4']]);
  });
  it('converts datetime wall-clock input in a field time zone', () => {
    expect(toLocalInput('2026-03-08T07:30:00.000Z', 'America/New_York')).toBe('2026-03-08T03:30:00');
    expect(fromLocalInput('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T03:30:00');
    expect(fromLocalInput('', 'UTC')).toBeNull();
  });
});
