import { describe, expect, it } from 'vitest';
import { buildCsv } from './csv';
import type { ApiRecord, Field } from '../types';

const f = (id: string, name: string, type: any, options: any = {}): Field => ({ id, name, type, options, position: 0, is_primary: false, indexed: false });
const rec = (fields: Record<string, any>): ApiRecord => ({ id: 'r', version: 1, fields, created_time: '', modified_time: '', created_by: null, updated_by: null });
const fields = [
  f('t', 'Title', 'text'), f('n', 'Count', 'integer'), f('c', 'Done', 'checkbox'),
  f('s', 'Status', 'single_select', { options: [{ id: 'o1', name: 'Open, now' }] }),
  f('m', 'Tags', 'multi_select', { options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
  f('a', 'Files', 'attachment'),
];
const ids = fields.map((x) => x.id);
const body = (rows: ApiRecord[], sel = ids) => buildCsv(fields, rows, sel).slice(1).split('\r\n');

describe('buildCsv', () => {
  it('starts with a BOM and ends with CRLF', () => {
    const out = buildCsv(fields, [], ids);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.endsWith('\r\n')).toBe(true);
  });
  it('quotes commas, quotes and newlines', () => {
    const l = body([rec({ t: 'a,"b"\nc' })], ['t']);
    expect(l[1]).toBe('"a,""b""\nc"');
  });
  it('neutralises formulas in text only', () => {
    for (const p of ['=1+1', '+1', '-1', '@x']) expect(body([rec({ t: p })], ['t'])[1]).toBe(`'${p}`);
    expect(buildCsv(fields, [rec({ t: '\tx' })], ['t'])).toContain("'\tx");
    expect(body([rec({ t: '=cmd' })], ['t'])[1]).toBe("'=cmd");
    expect(body([rec({ n: -5 })], ['n'])[1]).toBe('-5');
  });
  it('distinguishes empty, false and 0', () => {
    expect(body([rec({}), rec({ c: false, n: 0 })], ['c', 'n']).slice(1, 3)).toEqual([',', 'false,0']);
  });
  it('renders option names, multi-select and attachments', () => {
    expect(body([rec({ s: 'o1', m: ['a', 'b'], a: [{ filename: 'x.pdf' }, { filename: 'y.png' }] })], ['s', 'm', 'a'])[1]).toBe('"Open, now",A; B,x.pdf; y.png');
  });
});
