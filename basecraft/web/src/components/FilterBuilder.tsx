import { OPERATORS_BY_KIND, OPERATORS_SINGLE_SELECT, FIELD_SQL_KIND, type FilterOperator } from '@basecraft/shared';
import { CellEditor } from './CellEditor';
import { selectOptions } from '../lib/format';
import type { Field, FilterNode } from '../types';

const LABEL: Record<string, string> = {
  is_empty: 'is empty', is_not_empty: 'is not empty', eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with',
  gt: '>', gte: '≥', lt: '<', lte: '≤', is_true: 'is checked', is_false: 'is unchecked', has_any: 'has any of', has_all: 'has all of', has_none: 'has none of',
};
const NO_VALUE = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);
export const opsFor = (f: Field): FilterOperator[] => (f.type === 'single_select' ? OPERATORS_SINGLE_SELECT : OPERATORS_BY_KIND[FIELD_SQL_KIND[f.type]]);
const filterable = (f: Field) => f.type !== 'long_text' || true;

type Group = { and: FilterNode[] } | { or: FilterNode[] };
const isGroup = (n: FilterNode): n is Group => 'and' in n || 'or' in n;
const kidsOf = (g: Group): FilterNode[] => ('and' in g ? g.and : g.or);

export function toRoot(f?: FilterNode): Group { return !f ? { and: [] } : isGroup(f) ? f : { and: [f] }; }
/** Drops empty groups and incomplete conditions so the server never sees half-built filters. */
export function cleanFilter(n: FilterNode | undefined): FilterNode | undefined {
  if (!n) return undefined;
  if (isGroup(n)) {
    const kids = kidsOf(n).map(cleanFilter).filter((x): x is FilterNode => !!x);
    return kids.length ? ('and' in n ? { and: kids } : { or: kids }) : undefined;
  }
  if (!n.field || !n.op) return undefined;
  if (!NO_VALUE.has(n.op) && (n.value === undefined || n.value === '' || (Array.isArray(n.value) && !n.value.length))) return undefined;
  return n;
}
export function countConditions(n: FilterNode | undefined): number { return !n ? 0 : isGroup(n) ? kidsOf(n).reduce((a, k) => a + countConditions(k), 0) : 1; }

export function FilterBuilder({ fields, value, onChange }: { fields: Field[]; value?: FilterNode; onChange(v: FilterNode | undefined): void }) {
  const root = toRoot(value);
  const usable = fields.filter(filterable);
  if (!usable.length) return null;
  const emit = (g: Group) => onChange(kidsOf(g).length ? g : undefined);
  return (
    <div style={{ minWidth: 520, maxWidth: '90vw' }}>
      <GroupEditor group={root} fields={usable} depth={0} onChange={emit} />
      {countConditions(root) === 0 && <p className="hint">No filters: every record is shown.</p>}
    </div>
  );
}

function GroupEditor({ group, fields, depth, onChange, onRemove }: { group: Group; fields: Field[]; depth: number; onChange(g: Group): void; onRemove?(): void }) {
  const kind: 'and' | 'or' = 'and' in group ? 'and' : 'or';
  const kids = kidsOf(group);
  const set = (k: 'and' | 'or', nodes: FilterNode[]) => onChange(k === 'and' ? { and: nodes } : { or: nodes });
  const first = fields[0]!;
  return (
    <div style={{ borderLeft: depth ? '3px solid var(--border-strong)' : undefined, paddingLeft: depth ? 8 : 0, marginBottom: 6 }} role="group" aria-label={`Filter group (${kind === 'and' ? 'all' : 'any'} of)`}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="muted">Match</span>
        <select className="select" style={{ width: 'auto' }} value={kind} aria-label="Match all or any" onChange={(e) => set(e.target.value as 'and' | 'or', kids)}>
          <option value="and">all of</option><option value="or">any of</option>
        </select>
        <span className="muted">these conditions</span><span className="spacer" />
        {onRemove && <button className="btn small ghost" onClick={onRemove} aria-label="Remove group">Remove group</button>}
      </div>
      {kids.map((k, i) => isGroup(k)
        ? <GroupEditor key={i} group={k} fields={fields} depth={depth + 1} onChange={(g) => set(kind, kids.map((x, j) => (j === i ? g : x)))} onRemove={() => set(kind, kids.filter((_, j) => j !== i))} />
        : <ConditionRow key={i} node={k} fields={fields} onChange={(n) => set(kind, kids.map((x, j) => (j === i ? n : x)))} onRemove={() => set(kind, kids.filter((_, j) => j !== i))} />)}
      <div className="row">
        <button className="btn small" onClick={() => set(kind, [...kids, { field: first.id, op: opsFor(first)[0]! === 'is_empty' ? 'is_not_empty' : opsFor(first)[0]! }])}>+ Add condition</button>
        {depth < 2 && <button className="btn small" onClick={() => set(kind, [...kids, { or: [] } as any])}>+ Add group</button>}
      </div>
    </div>
  );
}

function ConditionRow({ node, fields, onChange, onRemove }: { node: Extract<FilterNode, { field: string }>; fields: Field[]; onChange(n: FilterNode): void; onRemove(): void }) {
  const f = fields.find((x) => x.id === node.field) ?? fields[0]!;
  const ops = opsFor(f);
  const valueEditor = () => {
    if (NO_VALUE.has(node.op)) return null;
    if (f.type === 'single_select' && (node.op === 'eq' || node.op === 'neq'))
      return <select className="select" aria-label="Value" value={(node.value as string) ?? ''} onChange={(e) => onChange({ ...node, value: e.target.value || undefined })}><option value="">Choose…</option>{selectOptions(f).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
    if (f.type === 'single_select' || f.type === 'multi_select')
      return <CellEditor field={{ ...f, type: 'multi_select' }} value={node.value} onChange={(v) => onChange({ ...node, value: v ?? undefined })} />;
    if (f.type === 'checkbox') return null;
    const ft: Field = ['created_time', 'modified_time'].includes(f.type) ? { ...f, type: 'datetime' } : f;
    return <CellEditor field={{ ...ft, options: { ...ft.options, timezone: undefined } }} value={node.value} onChange={(v) => onChange({ ...node, value: v ?? undefined })} />;
  };
  return (
    <div className="row wrap" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
      <select className="select" style={{ width: 150 }} aria-label="Field" value={f.id} onChange={(e) => { const nf = fields.find((x) => x.id === e.target.value)!; const nops = opsFor(nf); onChange({ field: nf.id, op: nops.includes(node.op as FilterOperator) ? node.op : nops[0]! }); }}>
        {fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <select className="select" style={{ width: 150 }} aria-label="Operator" value={node.op} onChange={(e) => onChange({ field: node.field, op: e.target.value, ...(NO_VALUE.has(e.target.value) ? {} : { value: node.value }) })}>
        {ops.map((o) => <option key={o} value={o}>{LABEL[o] ?? o}</option>)}
      </select>
      <div style={{ flex: 1, minWidth: 140 }}>{valueEditor()}</div>
      <button className="btn small ghost" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}
