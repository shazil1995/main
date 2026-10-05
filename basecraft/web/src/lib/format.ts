import type { Field, SelectOpt } from '../types';

export const selectOptions = (f: Field): SelectOpt[] => (f.options.options ?? []) as SelectOpt[];
export const optionById = (f: Field, id: unknown): SelectOpt | undefined => selectOptions(f).find((o) => o.id === id);

const TEXT_TYPES = new Set(['text', 'long_text', 'email', 'url', 'phone']);
export const isTextType = (t: string) => TEXT_TYPES.has(t);
export const READONLY = new Set(['created_time', 'modified_time', 'attachment']);
export const isReadonly = (f: Field) => READONLY.has(f.type);

/** Human display text for a cell. Empty (null/undefined) renders as '' — false and 0 render as themselves. */
export function displayValue(f: Field, v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (f.type) {
    case 'checkbox': return v ? '✓' : '✗';
    case 'single_select': return optionById(f, v)?.name ?? String(v);
    case 'multi_select': return Array.isArray(v) ? v.map((id) => optionById(f, id)?.name ?? id).join(', ') : '';
    case 'currency': return formatMoney(String(v), f.options.currency);
    case 'percent': return `${v}%`;
    case 'date': return formatDate(String(v));
    case 'datetime': case 'created_time': case 'modified_time': return formatDateTime(String(v), f.options.timezone);
    case 'attachment': return Array.isArray(v) ? v.map((a: any) => a.filename).join(', ') : '';
    default: return String(v);
  }
}

/** Money is a decimal STRING; format it without ever passing through a float. */
export function formatMoney(amount: string, currency: string): string {
  const neg = amount.startsWith('-');
  const [int = '0', frac] = amount.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = ({ USD: '$', EUR: '€', GBP: '£', JPY: '¥', PKR: 'Rs ', INR: '₹' } as Record<string, string>)[currency] ?? `${currency} `;
  return `${neg ? '-' : ''}${sym}${grouped}${frac !== undefined ? '.' + frac : ''}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
export function formatDateTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: tz ? 'short' : undefined });
}

/** `<input type=datetime-local>` value (wall clock) for a stored UTC instant, in the field's zone (or the browser's). */
export function toLocalInput(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
/** Wall-clock input back to an API value: naive when the field has a zone (server resolves DST), else an instant from the browser zone. */
export function fromLocalInput(local: string, tz?: string): string | null {
  if (!local) return null;
  if (tz) return local.length === 16 ? `${local}:00` : local;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Best-effort conversion of typed/pasted text into an API value. The server remains the authority and may still reject it. */
export function parseCellText(f: Field, text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  switch (f.type) {
    case 'checkbox': {
      const l = t.toLowerCase();
      if (['true', 'yes', 'y', '1', '✓', 'x', 'checked'].includes(l)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0', '✗', 'unchecked'].includes(l)) return { ok: true, value: false };
      return { ok: false, message: 'Use yes/no or true/false' };
    }
    case 'integer': return /^[+-]?\d+$/.test(t.replace(/,/g, '')) ? { ok: true, value: Number(t.replace(/,/g, '')) } : { ok: false, message: 'Must be a whole number' };
    case 'decimal': case 'currency': case 'percent': {
      const n = t.replace(/[,\s$€£¥₹]/g, '').replace(/%$/, '');
      return /^[+-]?\d+(\.\d+)?$/.test(n) ? { ok: true, value: n } : { ok: false, message: 'Must be a number' };
    }
    case 'single_select': {
      const o = selectOptions(f).find((x) => x.name.toLowerCase() === t.toLowerCase() || x.id === t);
      return o ? { ok: true, value: o.id } : { ok: false, message: `"${t}" is not an option` };
    }
    case 'multi_select': {
      const names = t.split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
      const ids: string[] = [];
      for (const n of names) { const o = selectOptions(f).find((x) => x.name.toLowerCase() === n.toLowerCase() || x.id === n); if (!o) return { ok: false, message: `"${n}" is not an option` }; ids.push(o.id); }
      return { ok: true, value: ids };
    }
    case 'created_time': case 'modified_time': case 'attachment': return { ok: false, message: 'Read-only field' };
    case 'datetime': return { ok: true, value: t.includes('T') || t.includes(' ') ? t.replace(' ', 'T') : t };
    default: return { ok: true, value: text };
  }
}

/** Text representation for copying cells to the clipboard (round-trips through parseCellText). */
export function copyText(f: Field, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (f.type === 'checkbox') return v ? 'true' : 'false';
  if (f.type === 'currency' || f.type === 'percent' || f.type === 'decimal') return String(v);
  if (f.type === 'single_select') return optionById(f, v)?.name ?? '';
  if (f.type === 'multi_select') return (v as string[]).map((id) => optionById(f, id)?.name ?? id).join('; ');
  if (f.type === 'attachment') return '';
  return String(v);
}

export function parseTsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n');
}

export const colorFor = (o?: SelectOpt) => o?.color ?? '#64748b';
