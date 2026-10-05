import { randomBytes } from 'node:crypto';
import { FIELD_SQL_KIND, LIMITS, READONLY_FIELD_TYPES, type FieldType, type SelectOption, type SqlKind } from '@basecraft/shared';
import { ValueError } from './errors.js';

export interface FieldRow {
  id: string;
  name: string;
  type: FieldType;
  options: Record<string, any>;
  position: number;
  is_primary: boolean;
  indexed: boolean;
}

export const isReadonlyType = (t: FieldType) => (READONLY_FIELD_TYPES as readonly string[]).includes(t);
export const sqlKind = (t: FieldType): SqlKind => FIELD_SQL_KIND[t];
export const isTextish = (t: FieldType) => ['text', 'long_text', 'email', 'url', 'phone'].includes(t);

export const newOptionId = () => 'opt_' + randomBytes(5).toString('hex');

// ───────── decimals: stored as canonical strings, never floats ─────────
const DEC_RE = /^[+-]?(\d+)(?:\.(\d+))?$/;
const MAX_DIGITS = 30;

/** Parse a number|string into a canonical decimal string with exactly `scale` fraction digits. No rounding: excess precision is rejected. */
export function canonicalDecimal(input: unknown, scale: number): string {
  let s: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new ValueError('Must be a finite number');
    s = Number.isInteger(input) ? String(input) : String(input);
    if (/e/i.test(s)) s = input.toFixed(Math.min(20, scale + 2)); // avoid exponent notation
  } else if (typeof input === 'string') {
    s = input.trim().replace(/^\+/, '');
  } else throw new ValueError('Must be a number or numeric string');
  const m = DEC_RE.exec(s);
  if (!m) throw new ValueError(`"${String(input).slice(0, 40)}" is not a valid number`);
  const neg = s.startsWith('-');
  const intPart = m[1]!.replace(/^0+(?=\d)/, '');
  let frac = m[2] ?? '';
  const extra = frac.slice(scale);
  if (/[1-9]/.test(extra)) throw new ValueError(`Too many decimal places (max ${scale})`);
  frac = frac.slice(0, scale).padEnd(scale, '0');
  if (intPart.length + scale > MAX_DIGITS) throw new ValueError('Number is too large');
  const isZero = /^0*$/.test(intPart) && /^0*$/.test(frac);
  return `${neg && !isZero ? '-' : ''}${intPart}${scale ? '.' + frac : ''}`;
}

/** Compare two canonical decimal strings exactly. */
export function cmpDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.replace('-', '').split('.');
  const [bi, bf = ''] = b.replace('-', '').split('.');
  const an = a.startsWith('-') && /[1-9]/.test(a), bn = b.startsWith('-') && /[1-9]/.test(b);
  if (an !== bn) return an ? -1 : 1;
  const w = Math.max(af.length, bf.length);
  const A = (ai!.replace(/^0+/, '') || '0'), B = (bi!.replace(/^0+/, '') || '0');
  let c = A.length !== B.length ? A.length - B.length : A < B ? -1 : A > B ? 1 : 0;
  if (c === 0) { const x = af.padEnd(w, '0'), y = bf.padEnd(w, '0'); c = x < y ? -1 : x > y ? 1 : 0; }
  return an ? -c : c;
}

// ───────── dates and time zones ─────────
export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1]!, mo = +m[2]!, d = +m[3]!;
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= dim;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (dtfCache.size > 64) dtfCache.clear();
    dtfCache.set(tz, f);
  }
  return f;
}
export function isValidTimeZone(tz: string): boolean {
  try { dtf(tz); return true; } catch { return false; }
}
/** Offset (ms) of `tz` at the UTC instant `t`. */
export function tzOffsetMs(tz: string, t: number): number {
  const p: Record<string, number> = {};
  for (const part of dtf(tz).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = +part.value;
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(t / 1000) * 1000;
}

const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Normalise an input to a UTC ISO instant (`YYYY-MM-DDTHH:MM:SS.mmmZ`, fixed width so text order == time order).
 * Inputs with an explicit offset are exact. Inputs WITHOUT an offset require a field time zone and are rejected
 * if the wall-clock time does not exist (DST gap) or is ambiguous (DST overlap).
 */
export function normalizeDatetime(input: unknown, tz?: string): string {
  if (typeof input !== 'string') throw new ValueError('Must be an ISO 8601 date-time string');
  const s = input.trim();
  const mo = OFFSET_RE.exec(s);
  if (mo) {
    if (!isValidDate(mo[1]!)) throw new ValueError('Invalid calendar date');
    const [hh, mm, ss] = [+mo[2]!, +mo[3]!, +(mo[4] ?? 0)];
    if (hh > 23 || mm > 59 || ss > 59) throw new ValueError('Invalid time of day');
    const ms = mo[5] ? Math.floor(+(mo[5].padEnd(9, '0').slice(0, 3))) : 0;
    let off = 0;
    if (mo[6]!.toUpperCase() !== 'Z') {
      const z = mo[6]!.replace(':', '');
      const oh = +z.slice(1, 3), om = +z.slice(3, 5);
      if (oh > 23 || om > 59) throw new ValueError('Invalid UTC offset');
      off = (z[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
    }
    const [y, mth, d] = mo[1]!.split('-').map(Number) as [number, number, number];
    const t = Date.UTC(y, mth - 1, d, hh, mm, ss, ms) - off;
    return isoFromMs(t);
  }
  const mn = NAIVE_RE.exec(s);
  if (!mn) throw new ValueError('Must be an ISO 8601 date-time such as 2026-03-08T14:30:00Z');
  if (!tz) throw new ValueError('A UTC offset (e.g. Z or +05:00) is required because this field has no time zone');
  if (!isValidDate(mn[1]!)) throw new ValueError('Invalid calendar date');
  const [hh, mm, ss] = [+mn[2]!, +mn[3]!, +(mn[4] ?? 0)];
  if (hh > 23 || mm > 59 || ss > 59) throw new ValueError('Invalid time of day');
  const ms = mn[5] ? +mn[5].padEnd(3, '0') : 0;
  const [y, mth, d] = mn[1]!.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, mth - 1, d, hh, mm, ss, ms);
  const candidates = new Set<number>();
  for (const probe of [naive - 36 * 3600_000, naive, naive + 36 * 3600_000]) {
    const o = tzOffsetMs(tz, probe);
    const t = naive - o;
    if (tzOffsetMs(tz, t) === o) candidates.add(t);
  }
  if (candidates.size === 0) throw new ValueError(`That local time does not exist in ${tz} (daylight-saving gap)`);
  if (candidates.size > 1) throw new ValueError(`That local time is ambiguous in ${tz} (daylight-saving overlap); include a UTC offset`);
  return isoFromMs([...candidates][0]!);
}
function isoFromMs(t: number): string {
  if (!Number.isFinite(t)) throw new ValueError('Invalid date-time');
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (y < 1 || y > 9999) throw new ValueError('Year out of range');
  return d.toISOString().replace(/^\+?0*(\d{4})/, '$1');
}

// ───────── per-type normalization ─────────
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
let currencies: Set<string> | undefined;
export function isCurrencyCode(c: string): boolean {
  currencies ??= new Set((Intl as any).supportedValuesOf('currency') as string[]);
  return currencies.has(c);
}
export function currencyScale(code: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Validates and normalises field options on create. Throws ValueError. */
export function normalizeFieldOptions(type: FieldType, raw: Record<string, any> | undefined): Record<string, any> {
  const o = { ...(raw ?? {}) };
  switch (type) {
    case 'decimal':
    case 'percent': {
      const scale = o.scale ?? 2;
      if (!Number.isInteger(scale) || scale < 0 || scale > 8) throw new ValueError('scale must be an integer 0-8');
      return { scale, ...(o.min !== undefined ? { min: canonicalDecimal(o.min, scale) } : {}), ...(o.max !== undefined ? { max: canonicalDecimal(o.max, scale) } : {}) };
    }
    case 'currency': {
      if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency) || !isCurrencyCode(o.currency)) throw new ValueError('currency must be an ISO 4217 code such as USD');
      return { currency: o.currency, scale: currencyScale(o.currency) };
    }
    case 'integer':
      return { ...(o.min !== undefined ? { min: Number(o.min) } : {}), ...(o.max !== undefined ? { max: Number(o.max) } : {}) };
    case 'datetime': {
      if (o.timezone !== undefined && (typeof o.timezone !== 'string' || !isValidTimeZone(o.timezone))) throw new ValueError('timezone must be a valid IANA time zone');
      return o.timezone ? { timezone: o.timezone } : {};
    }
    case 'single_select':
    case 'multi_select': {
      const list: unknown = o.options ?? [];
      if (!Array.isArray(list) || list.length > 200) throw new ValueError('options must be an array of at most 200 choices');
      const seen = new Set<string>();
      const options: SelectOption[] = list.map((x: any) => {
        const name = typeof x === 'string' ? x : x?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new ValueError('Each option needs a name (max 100 chars)');
        if (seen.has(name.toLowerCase())) throw new ValueError(`Duplicate option "${name}"`);
        seen.add(name.toLowerCase());
        const id = typeof x === 'object' && typeof x.id === 'string' && /^opt_[a-z0-9]{6,20}$/.test(x.id) ? x.id : newOptionId();
        return { id, name: name.trim(), ...(typeof x?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(x.color) ? { color: x.color } : {}) };
      });
      return { options };
    }
    default:
      return {};
  }
}

/**
 * Normalise a writable cell value. Returns `null` for "empty" (the key is removed from storage).
 * Important distinctions: `false` and `0` and `"0"` are VALUES; `null`, `""` (text) and `[]` are empty.
 */
export function normalizeValue(field: Pick<FieldRow, 'type' | 'options'>, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const o = field.options;
  switch (field.type) {
    case 'text':
    case 'long_text': {
      if (typeof v !== 'string') throw new ValueError('Must be text');
      const max = field.type === 'text' ? LIMITS.maxShortTextLength : LIMITS.maxTextLength;
      if (v.length > max) throw new ValueError(`Too long (max ${max} characters)`);
      if (field.type === 'text' && /[\r\n]/.test(v)) throw new ValueError('Single-line text cannot contain line breaks');
      if (v.includes('\u0000')) throw new ValueError('Invalid character');
      return v === '' ? null : v;
    }
    case 'integer': {
      let n: number;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) n = Number(v.trim());
      else throw new ValueError('Must be a whole number');
      if (!Number.isInteger(n)) throw new ValueError('Must be a whole number');
      if (!Number.isSafeInteger(n)) throw new ValueError('Whole number out of range');
      if (typeof o.min === 'number' && n < o.min) throw new ValueError(`Must be at least ${o.min}`);
      if (typeof o.max === 'number' && n > o.max) throw new ValueError(`Must be at most ${o.max}`);
      return Object.is(n, -0) ? 0 : n;
    }
    case 'decimal':
    case 'percent':
    case 'currency': {
      if (typeof v === 'string' && v.trim() === '') return null;
      const d = canonicalDecimal(v, o.scale ?? 2);
      if (o.min !== undefined && cmpDecimal(d, o.min) < 0) throw new ValueError(`Must be at least ${o.min}`);
      if (o.max !== undefined && cmpDecimal(d, o.max) > 0) throw new ValueError(`Must be at most ${o.max}`);
      return d;
    }
    case 'date': {
      if (typeof v !== 'string') throw new ValueError('Must be a date like 2026-03-08');
      if (v.trim() === '') return null;
      if (!isValidDate(v.trim())) throw new ValueError('Must be a valid date like 2026-03-08');
      return v.trim();
    }
    case 'datetime':
      if (typeof v === 'string' && v.trim() === '') return null;
      return normalizeDatetime(v, o.timezone);
    case 'checkbox':
      if (typeof v !== 'boolean') throw new ValueError('Must be true or false');
      return v;
    case 'single_select': {
      if (typeof v !== 'string') throw new ValueError('Must be an option id or name');
      if (v === '') return null;
      const opt = resolveOption(o.options, v);
      if (!opt) throw new ValueError(`"${v.slice(0, 40)}" is not one of the allowed options`);
      return opt.id;
    }
    case 'multi_select': {
      if (!Array.isArray(v)) throw new ValueError('Must be a list of options');
      if (v.length > 100) throw new ValueError('Too many selections');
      const ids = new Set<string>();
      for (const x of v) {
        if (typeof x !== 'string') throw new ValueError('Options must be strings');
        const opt = resolveOption(o.options, x);
        if (!opt) throw new ValueError(`"${x.slice(0, 40)}" is not one of the allowed options`);
        ids.add(opt.id);
      }
      return ids.size ? [...ids] : null;
    }
    case 'email': {
      if (typeof v !== 'string') throw new ValueError('Must be an email address');
      const e = v.trim();
      if (e === '') return null;
      if (e.length > 254 || !EMAIL_RE.test(e)) throw new ValueError('Must be a valid email address');
      return e;
    }
    case 'url': {
      if (typeof v !== 'string') throw new ValueError('Must be a URL');
      const u = v.trim();
      if (u === '') return null;
      if (u.length > 2000) throw new ValueError('URL too long');
      let parsed: URL;
      try { parsed = new URL(u); } catch { throw new ValueError('Must be a valid URL including http:// or https://'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValueError('Only http and https URLs are allowed');
      return u;
    }
    case 'phone': {
      if (typeof v !== 'string') throw new ValueError('Must be a phone number');
      const raw = v.trim();
      if (raw === '') return null;
      if (!/^[+\d\s().-]+$/.test(raw)) throw new ValueError('Phone numbers may contain only digits, spaces and + ( ) . -');
      const digits = raw.replace(/[^\d+]/g, '');
      if (digits.lastIndexOf('+') > 0) throw new ValueError('"+" is only allowed at the start');
      const count = digits.replace('+', '').length;
      if (count < 7 || count > 15) throw new ValueError('Phone numbers need 7 to 15 digits');
      return digits;
    }
    default:
      throw new ValueError('This field cannot be written directly');
  }
}

export function resolveOption(options: SelectOption[] | undefined, v: string): SelectOption | undefined {
  if (!options) return undefined;
  return options.find((x) => x.id === v) ?? options.find((x) => x.name.toLowerCase() === v.toLowerCase());
}

/** Text used for substring search. Only stable, text-like content is indexed (select names are matched at query time). */
export function searchTextOf(fields: FieldRow[], values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === null) continue;
    if (isTextish(f.type) || f.type === 'integer' || f.type === 'decimal' || f.type === 'currency' || f.type === 'percent') parts.push(String(v));
  }
  return parts.join(' \u001f ').toLowerCase().slice(0, 4000);
}

/** CSV cell text -> value for import, with explicit conversions. Returns undefined for "leave empty". */
export function fromCsvCell(field: FieldRow, cell: string): unknown {
  const t = cell.trim();
  if (t === '') return null;
  switch (field.type) {
    case 'checkbox': {
      const l = t.toLowerCase();
      if (['true', 'yes', 'y', '1', 'checked', 'x'].includes(l)) return true;
      if (['false', 'no', 'n', '0', 'unchecked'].includes(l)) return false;
      throw new ValueError(`"${t.slice(0, 30)}" is not a recognised yes/no value`);
    }
    case 'multi_select':
      return t.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
    case 'integer':
      return t.replace(/,/g, '');
    case 'decimal':
    case 'currency':
    case 'percent':
      return t.replace(/[,\s]/g, '').replace(/%$/, '');
    case 'text':
      return cell;
    default:
      return cell;
  }
}

/** Value -> CSV text. */
export function toCsvCell(field: Pick<FieldRow, 'type' | 'options'>, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (field.type === 'multi_select' && Array.isArray(v)) {
    const opts = (field.options.options ?? []) as SelectOption[];
    return v.map((id) => opts.find((o) => o.id === id)?.name ?? String(id)).join('; ');
  }
  if (field.type === 'single_select') return ((field.options.options ?? []) as SelectOption[]).find((o) => o.id === v)?.name ?? String(v);
  if (field.type === 'checkbox') return v ? 'true' : 'false';
  if (field.type === 'attachment' && Array.isArray(v)) return v.map((a: any) => a.filename).join('; ');
  return String(v);
}
