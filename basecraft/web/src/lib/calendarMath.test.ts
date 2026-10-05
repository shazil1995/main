import { describe, expect, it } from 'vitest';
import { addDays, bucketByDay, daysInMonth, diffDays, eventDays, instantDayKey, instantRange, monthGrid, shiftMonth, zonedDayStart, zonedWallToInstant } from './calendarMath';

describe('monthGrid', () => {
  it('starts on Sunday and is whole weeks', () => {
    const g = monthGrid(2026, 10); // Oct 2026 starts Thursday
    expect(g[0]!.key).toBe('2026-09-27');
    expect(g.length % 7).toBe(0);
    expect(g.at(-1)!.key).toBe('2026-10-31');
    expect(g.filter((c) => c.inMonth)).toHaveLength(31);
  });
  it('handles leap years and Feb 29', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    const g = monthGrid(2024, 2);
    expect(g.some((c) => c.key === '2024-02-29' && c.inMonth)).toBe(true);
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
  });
  it('uses 6 rows when needed and 4 when possible', () => {
    expect(monthGrid(2026, 8)).toHaveLength(42); // Aug 2026 starts Saturday, 31 days
    expect(monthGrid(2026, 2)).toHaveLength(28); // Feb 2026 starts Sunday
  });
  it('shifts months across years', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 3, -15)).toEqual({ year: 2024, month: 12 });
  });
  it('diffDays is DST independent', () => { expect(diffDays('2026-03-07', '2026-03-09')).toBe(2); });
});

describe('bucketing', () => {
  it('clamps multi-day events to the grid', () => {
    expect(eventDays('2026-09-20', '2026-09-29', '2026-09-27', '2026-10-31')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    expect(eventDays('2026-10-30', '2026-11-05', '2026-09-27', '2026-10-31')).toEqual(['2026-10-30', '2026-10-31']);
    expect(eventDays('2026-11-01', null, '2026-09-27', '2026-10-31')).toEqual([]);
    expect(eventDays('2026-10-05', '2026-10-01', '2026-09-27', '2026-10-31')).toEqual(['2026-10-05']);
  });
  it('buckets items per day', () => {
    const m = bucketByDay([{ item: 'a', start: '2026-10-01', end: '2026-10-02' }, { item: 'b', start: '2026-10-02', end: '2026-10-02' }], '2026-09-27', '2026-10-31');
    expect(m.get('2026-10-01')).toEqual(['a']);
    expect(m.get('2026-10-02')).toEqual(['a', 'b']);
  });
});

describe('day keys for instants', () => {
  it('New York around spring-forward 2026-03-08', () => {
    const tz = 'America/New_York';
    expect(instantDayKey('2026-03-08T04:59:59Z', tz)).toBe('2026-03-07'); // 23:59:59 EST
    expect(instantDayKey('2026-03-08T05:00:00Z', tz)).toBe('2026-03-08'); // 00:00 EST
    expect(instantDayKey('2026-03-09T03:59:59Z', tz)).toBe('2026-03-08'); // 23:59:59 EDT
    expect(instantDayKey('2026-03-09T04:00:00Z', tz)).toBe('2026-03-09');
  });
  it('New York around fall-back 2026-11-01', () => {
    const tz = 'America/New_York';
    expect(instantDayKey('2026-11-01T03:59:59Z', tz)).toBe('2026-10-31'); // 23:59:59 EDT
    expect(instantDayKey('2026-11-01T04:00:00Z', tz)).toBe('2026-11-01');
    expect(instantDayKey('2026-11-02T04:59:59Z', tz)).toBe('2026-11-01'); // 23:59:59 EST (25h day)
    expect(instantDayKey('2026-11-02T05:00:00Z', tz)).toBe('2026-11-02');
  });
  it('Karachi (+05:00, no DST) shifts evening UTC into next day', () => {
    const tz = 'Asia/Karachi';
    expect(instantDayKey('2026-03-08T18:59:59Z', tz)).toBe('2026-03-08');
    expect(instantDayKey('2026-03-08T19:00:00Z', tz)).toBe('2026-03-09');
    expect(instantDayKey('2026-11-01T19:30:00Z', tz)).toBe('2026-11-02');
    expect(instantDayKey('2026-10-31T19:00:00Z', tz)).toBe('2026-11-01');
  });
  it('month boundary and invalid input', () => {
    expect(instantDayKey('2026-03-31T20:00:00Z', 'Asia/Karachi')).toBe('2026-04-01');
    expect(instantDayKey('nope', 'UTC')).toBeNull();
  });
});

describe('zoned day starts and ranges', () => {
  it('day start across DST in New York', () => {
    const tz = 'America/New_York';
    expect(new Date(zonedDayStart('2026-03-08', tz)).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(zonedDayStart('2026-03-09', tz)).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(new Date(zonedDayStart('2026-11-01', tz)).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(zonedDayStart('2026-11-02', tz)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
  it('day start in Karachi', () => {
    expect(new Date(zonedDayStart('2026-03-08', 'Asia/Karachi')).toISOString()).toBe('2026-03-07T19:00:00.000Z');
  });
  it('range covers the grid inclusive', () => {
    const r = instantRange('2026-03-01', '2026-03-14', 'America/New_York');
    expect(r.from).toBe('2026-03-01T05:00:00.000Z');
    expect(r.to).toBe('2026-03-15T03:59:59.999Z');
  });
  it('09:00 wall time', () => {
    expect(new Date(zonedWallToInstant('2026-03-08', 9, 0, 'America/New_York')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(new Date(zonedWallToInstant('2026-03-07', 9, 0, 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(zonedWallToInstant('2026-11-01', 9, 0, 'Asia/Karachi')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
});
