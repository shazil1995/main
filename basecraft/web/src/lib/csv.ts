import { csvSafeCell } from '@basecraft/shared';
import type { ApiRecord, Field } from '../types';

/** Types whose text is produced from validated values, so they can never start a spreadsheet formula. */
const NO_SANITIZE = new Set(['integer', 'decimal', 'currency', 'percent', 'date', 'datetime', 'created_time', 'modified_time', 'checkbox']);

/** RFC 4180 quoting. */
export function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Plain text for a value, mirroring the server's export rules. null/undefined is empty; false and 0 are kept. */
export function cellText(f: Pick<Field, 'type' | 'options'>, v: unknown): string {
  if (v === null || v === undefined) return '';
  const opts = (f.options?.options ?? []) as { id: string; name: string }[];
  if (f.type === 'multi_select' && Array.isArray(v)) return v.map((id) => opts.find((o) => o.id === id)?.name ?? String(id)).join('; ');
  if (f.type === 'single_select') return opts.find((o) => o.id === v)?.name ?? String(v);
  if (f.type === 'checkbox') return v ? 'true' : 'false';
  if (f.type === 'attachment' && Array.isArray(v)) return v.map((a: any) => a.filename).join('; ');
  return String(v);
}

export function csvCell(f: Pick<Field, 'type' | 'options'>, v: unknown): string {
  const t = cellText(f, v);
  return csvEscape(NO_SANITIZE.has(f.type) ? t : csvSafeCell(t));
}

/** Build a CSV (UTF-8 BOM, CRLF) of the given rows for the selected fields, in the order of `fieldIds`. */
export function buildCsv(fields: Field[], rows: ApiRecord[], fieldIds: string[]): string {
  const cols = fieldIds.map((id) => fields.find((f) => f.id === id)).filter((f): f is Field => !!f);
  const lines = [cols.map((f) => csvEscape(csvSafeCell(f.name))).join(',')];
  for (const r of rows) lines.push(cols.map((f) => csvCell(f, r.fields[f.id])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function downloadBlob(text: string, filename: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
