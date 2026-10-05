/** Pure date math for the calendar view. Day keys are 'YYYY-MM-DD' strings (no time zone attached). */

export interface DayCell { key: string; year: number; month: number; day: number; inMonth: boolean; dow: number }

const p2 = (n: number) => String(n).padStart(2, '0');
export const makeKey = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;
export function parseKey(key: string): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!mt) return null;
  return { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) };
}
const keyToUtc = (key: string) => { const k = parseKey(key)!; return Date.UTC(k.y, k.m - 1, k.d); };
const utcToKey = (t: number) => { const d = new Date(t); return makeKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };

export const addDays = (key: string, n: number) => utcToKey(keyToUtc(key) + n * 86_400_000);
export const diffDays = (a: string, b: string) => Math.round((keyToUtc(b) - keyToUtc(a)) / 86_400_000);
export const dayOfWeek = (key: string) => new Date(keyToUtc(key)).getUTCDay();
export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number) => [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** Weeks (starting Sunday) covering the month: 4 to 6 rows of 7. `month` is 1-12. */
export function monthGrid(year: number, month: number): DayCell[] {
  const first = makeKey(year, month, 1);
  const lead = dayOfWeek(first);
  const weeks = Math.ceil((lead + daysInMonth(year, month)) / 7);
  const start = addDays(first, -lead);
  const out: DayCell[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const key = addDays(start, i);
    const k = parseKey(key)!;
    out.push({ key, year: k.y, month: k.m, day: k.d, inMonth: k.y === year && k.m === month, dow: i % 7 });
  }
  return out;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Local day key for "today" in the browser zone (or an explicit zone). */
export function todayKey(now: Date = new Date(), tz?: string): string { return instantDayKey(now.toISOString(), tz) ?? utcToKey(now.getTime()); }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string | undefined) {
  const k = tz ?? '';
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(k, f);
  }
  return f;
}
function wallParts(t: number, tz?: string) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Calendar day that a UTC instant falls on in `tz` (browser zone when omitted). null if unparsable. */
export function instantDayKey(iso: string, tz?: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const w = wallParts(t, tz);
  return makeKey(w.year, w.month, w.day);
}

/** Offset (zone wall clock minus UTC) in ms at instant t. */
export function zoneOffsetMs(t: number, tz?: string): number {
  const w = wallParts(t, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

/** UTC instant (ms) of the first moment of `key` in `tz`. DST-safe, including zones where the transition happens at midnight. */
export function zonedDayStart(key: string, tz?: string): number {
  const k = parseKey(key)!;
  if (!tz) return new Date(k.y, k.m - 1, k.d, 0, 0, 0, 0).getTime();
  const guess = Date.UTC(k.y, k.m - 1, k.d);
  let t = guess - zoneOffsetMs(guess, tz);
  const off2 = zoneOffsetMs(t, tz);
  t = guess - off2;
  // If a midnight gap pushed us onto the previous day, step forward until the day matches.
  let guard = 0;
  while (instantDayKey(new Date(t).toISOString(), tz)! < key && guard++ < 3) t += 3_600_000;
  return t;
}

/** UTC instant for a wall-clock time on `key` in `tz` (used for the 09:00 default). Falls forward through DST gaps. */
export function zonedWallToInstant(key: string, hour: number, minute: number, tz?: string): number {
  const k = parseKey(key)!;
  if (!tz) return new Date(k.y, k.m - 1, k.d, hour, minute, 0, 0).getTime();
  const guess = Date.UTC(k.y, k.m - 1, k.d, hour, minute);
  const o1 = zoneOffsetMs(guess - zoneOffsetMs(guess, tz), tz);
  return guess - o1;
}

/** ISO bounds [from, to] (inclusive) of whole days startKey..endKey in `tz`. */
export function instantRange(startKey: string, endKey: string, tz?: string): { from: string; to: string } {
  return {
    from: new Date(zonedDayStart(startKey, tz)).toISOString(),
    to: new Date(zonedDayStart(addDays(endKey, 1), tz) - 1).toISOString(),
  };
}

/** Days (clamped to the grid) covered by an event spanning startKey..endKey. Missing/invalid end => single day. */
export function eventDays(startKey: string, endKey: string | null | undefined, gridStart: string, gridEnd: string): string[] {
  let end = endKey && endKey >= startKey ? endKey : startKey;
  if (end < gridStart || startKey > gridEnd) return [];
  const from = startKey < gridStart ? gridStart : startKey;
  if (end > gridEnd) end = gridEnd;
  const n = diffDays(from, end);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export interface DayItem<T> { item: T; start: string; end: string }
/** Bucket items into day keys within the grid. */
export function bucketByDay<T>(items: DayItem<T>[], gridStart: string, gridEnd: string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    for (const d of eventDays(it.start, it.end, gridStart, gridEnd)) {
      const a = m.get(d);
      if (a) a.push(it.item); else m.set(d, [it.item]);
    }
  }
  return m;
}
