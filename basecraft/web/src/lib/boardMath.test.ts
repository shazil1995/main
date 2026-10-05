import { describe, expect, it } from 'vitest';
import type { Field } from '../types';
import { andFilter, cardFieldsFor, validGroupField } from './boardMath';

const f = (id: string, position: number, extra: Partial<Field> = {}): Field => ({ id, name: id, type: 'text', options: {}, position, is_primary: false, indexed: false, ...extra });
const fields = [f('p', 0, { is_primary: true }), f('a', 1), f('b', 2), f('c', 3), f('d', 4), f('s', 5, { type: 'single_select' })];

describe('andFilter', () => {
  it('skips undefined and collapses', () => {
    expect(andFilter(undefined, undefined)).toBeUndefined();
    expect(andFilter(undefined, { field: 'a', op: 'eq', value: 1 })).toEqual({ field: 'a', op: 'eq', value: 1 });
    expect(andFilter({ and: [] }, { field: 'a', op: 'eq', value: 1 })).toEqual({ field: 'a', op: 'eq', value: 1 });
    expect(andFilter({ or: [{ field: 'a', op: 'eq' }] }, { field: 'b', op: 'eq' })).toEqual({ and: [{ or: [{ field: 'a', op: 'eq' }] }, { field: 'b', op: 'eq' }] });
  });
});
describe('cardFieldsFor', () => {
  it('defaults to first visible non-primary fields', () => {
    expect(cardFieldsFor(fields, undefined, ['a'], 3).map((x) => x.id)).toEqual(['b', 'c', 'd']);
  });
  it('respects configured ids and drops stale/primary ones', () => {
    expect(cardFieldsFor(fields, ['d', 'zzz', 'p', 'a'], undefined, 3).map((x) => x.id)).toEqual(['d', 'a']);
  });
});
describe('validGroupField', () => {
  it('requires a single_select', () => {
    expect(validGroupField(fields, { kanban: { groupField: 's' } })?.id).toBe('s');
    expect(validGroupField(fields, { kanban: { groupField: 'a' } })).toBeUndefined();
    expect(validGroupField(fields, {})).toBeUndefined();
  });
});
