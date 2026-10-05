import type { Field, FilterNode, ViewConfig } from '../types';

/** Combine filters with AND, skipping undefined. Returns undefined when nothing is left. */
export function andFilter(...nodes: (FilterNode | undefined | null)[]): FilterNode | undefined {
  const list = nodes.filter((n): n is FilterNode => !!n && !('and' in n && n.and.length === 0) && !('or' in n && n.or.length === 0));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { and: list };
}

/** Fields to show on a card: the configured ids (that still exist, never the primary) or the first `max` visible non-primary fields. */
export function cardFieldsFor(fields: Field[], configured: string[] | undefined, hidden: string[] | undefined, max: number, includePrimary = false): Field[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  if (configured && configured.length) {
    return configured.map((id) => byId.get(id)).filter((f): f is Field => !!f && (includePrimary || !f.is_primary)).slice(0, max);
  }
  const hide = new Set(hidden ?? []);
  return [...fields].sort((a, b) => a.position - b.position).filter((f) => (includePrimary || !f.is_primary) && !hide.has(f.id)).slice(0, max);
}

export const primaryField = (fields: Field[]): Field | undefined => fields.find((f) => f.is_primary) ?? fields[0];

export function singleSelectFields(fields: Field[]): Field[] { return fields.filter((f) => f.type === 'single_select'); }
export const validGroupField = (fields: Field[], config: ViewConfig): Field | undefined => {
  const f = fields.find((x) => x.id === config.kanban?.groupField);
  return f && f.type === 'single_select' ? f : undefined;
};
