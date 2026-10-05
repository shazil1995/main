import { describe, expect, it } from 'vitest';
import { canonicalDecimal, cmpDecimal, isValidDate, normalizeDatetime, normalizeFieldOptions, normalizeValue } from '../src/fieldTypes.js';
import { ValueError } from '../src/errors.js';

const f = (type: any, options: any = {}) => ({ type, options: normalizeFieldOptions(type, options) });

describe('empty vs false vs zero', () => {
  it('keeps false and zero as values, treats null/empty as empty', () => {
    expect(normalizeValue(f('checkbox'), false)).toBe(false);
    expect(normalizeValue(f('checkbox'), null)).toBeNull();
    expect(normalizeValue(f('integer'), 0)).toBe(0);
    expect(normalizeValue(f('integer'), '0')).toBe(0);
    expect(normalizeValue(f('decimal'), 0)).toBe('0.00');
    expect(normalizeValue(f('decimal'), '')).toBeNull();
    expect(normalizeValue(f('text'), '')).toBeNull();
    expect(normalizeValue(f('text'), '0')).toBe('0');
    expect(normalizeValue(f('multi_select', { options: ['a'] }), [])).toBeNull();
  });
  it('rejects wrong types strictly', () => {
    expect(() => normalizeValue(f('checkbox'), 'true')).toThrow(ValueError);
    expect(() => normalizeValue(f('integer'), 1.5)).toThrow(ValueError);
    expect(() => normalizeValue(f('integer'), '12abc')).toThrow(ValueError);
    expect(() => normalizeValue(f('text'), 5)).toThrow(ValueError);
    expect(() => normalizeValue(f('text'), 'a\nb')).toThrow(ValueError);
  });
});

describe('decimals and money', () => {
  it('is exact, never float', () => {
    expect(canonicalDecimal('0.1', 2)).toBe('0.10');
    expect(() => canonicalDecimal(0.1 + 0.2, 2)).toThrow(/decimal places/); // float noise is rejected, not rounded
    expect(canonicalDecimal('12345678901234567890.12', 2)).toBe('12345678901234567890.12');
    expect(canonicalDecimal('-0.00', 2)).toBe('0.00');
    expect(canonicalDecimal('007.5', 1)).toBe('7.5');
  });
  it('refuses silent rounding', () => {
    expect(() => canonicalDecimal('1.005', 2)).toThrow(/decimal places/);
    expect(canonicalDecimal('1.500', 2)).toBe('1.50');
  });
  it('compares exactly', () => {
    expect(cmpDecimal('10.00', '9.99')).toBeGreaterThan(0);
    expect(cmpDecimal('-1.00', '0.00')).toBeLessThan(0);
    expect(cmpDecimal('-2.00', '-1.00')).toBeLessThan(0);
    expect(cmpDecimal('1.10', '1.1')).toBe(0);
  });
  it('currency requires a valid ISO code and fixes scale', () => {
    expect(() => normalizeFieldOptions('currency', {})).toThrow();
    expect(() => normalizeFieldOptions('currency', { currency: 'XXQ' })).toThrow();
    expect(normalizeFieldOptions('currency', { currency: 'USD' })).toEqual({ currency: 'USD', scale: 2 });
    expect(normalizeFieldOptions('currency', { currency: 'JPY' })).toEqual({ currency: 'JPY', scale: 0 });
    expect(normalizeValue(f('currency', { currency: 'USD' }), '19.9')).toBe('19.90');
    expect(() => normalizeValue(f('currency', { currency: 'JPY' }), '1.5')).toThrow();
  });
  it('enforces min/max', () => {
    const p = f('percent', { scale: 1, min: 0, max: 100 });
    expect(normalizeValue(p, '99.9')).toBe('99.9');
    expect(() => normalizeValue(p, '100.1')).toThrow();
    expect(() => normalizeValue(p, '-0.1')).toThrow();
  });
});

describe('dates', () => {
  it('validates the calendar including leap years', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('1900-02-29')).toBe(false);
    expect(isValidDate('2000-02-29')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-04-31')).toBe(false);
  });
  it('normalises offsets to UTC', () => {
    expect(normalizeDatetime('2026-03-08T14:30:00+05:00')).toBe('2026-03-08T09:30:00.000Z');
    expect(normalizeDatetime('2026-03-08T14:30:00.5Z')).toBe('2026-03-08T14:30:00.500Z');
    expect(normalizeDatetime('2026-03-08T14:30Z')).toBe('2026-03-08T14:30:00.000Z');
  });
  it('requires an offset when the field has no timezone', () => {
    expect(() => normalizeDatetime('2026-03-08T14:30:00')).toThrow(/offset/);
  });
  it('handles DST gap, overlap and normal times in America/New_York', () => {
    const tz = 'America/New_York';
    expect(normalizeDatetime('2026-01-15T09:00:00', tz)).toBe('2026-01-15T14:00:00.000Z');
    expect(normalizeDatetime('2026-07-15T09:00:00', tz)).toBe('2026-07-15T13:00:00.000Z');
    // 2026-03-08 02:30 does not exist (spring forward)
    expect(() => normalizeDatetime('2026-03-08T02:30:00', tz)).toThrow(/does not exist/);
    // 2026-11-01 01:30 happens twice (fall back)
    expect(() => normalizeDatetime('2026-11-01T01:30:00', tz)).toThrow(/ambiguous/);
    // explicit offsets resolve the ambiguity
    expect(normalizeDatetime('2026-11-01T01:30:00-04:00', tz)).toBe('2026-11-01T05:30:00.000Z');
    expect(normalizeDatetime('2026-11-01T01:30:00-05:00', tz)).toBe('2026-11-01T06:30:00.000Z');
    expect(normalizeDatetime('2026-03-08T03:30:00', tz)).toBe('2026-03-08T07:30:00.000Z');
  });
  it('handles half-hour and southern-hemisphere zones', () => {
    expect(normalizeDatetime('2026-06-01T12:00:00', 'Asia/Kolkata')).toBe('2026-06-01T06:30:00.000Z');
    expect(normalizeDatetime('2026-01-01T12:00:00', 'Australia/Sydney')).toBe('2026-01-01T01:00:00.000Z');
    expect(normalizeDatetime('2026-06-01T12:00:00', 'Asia/Karachi')).toBe('2026-06-01T07:00:00.000Z');
  });
});

describe('selects, contact fields', () => {
  it('maps option names to stable ids', () => {
    const fld = f('single_select', { options: ['Open', 'Closed'] });
    const id = fld.options.options[0].id;
    expect(normalizeValue(fld, 'open')).toBe(id);
    expect(normalizeValue(fld, id)).toBe(id);
    expect(() => normalizeValue(fld, 'Nope')).toThrow();
    expect(() => normalizeFieldOptions('single_select', { options: ['a', 'A'] })).toThrow(/Duplicate/);
  });
  it('validates email, url, phone', () => {
    expect(normalizeValue(f('email'), ' a@b.co ')).toBe('a@b.co');
    expect(() => normalizeValue(f('email'), 'nope')).toThrow();
    expect(() => normalizeValue(f('url'), 'javascript:alert(1)')).toThrow();
    expect(() => normalizeValue(f('url'), 'example.com')).toThrow();
    expect(normalizeValue(f('url'), 'https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(normalizeValue(f('phone'), '+92 (300) 123-4567')).toBe('+923001234567');
    expect(() => normalizeValue(f('phone'), 'call me')).toThrow();
    expect(() => normalizeValue(f('phone'), '123')).toThrow();
  });
  it('refuses writes to readonly types', () => {
    expect(() => normalizeValue(f('created_time'), 'x')).toThrow();
  });
});
