import { useQueries } from '@tanstack/react-query';
import { get } from '../../api';
import { qk, useBases } from '../../lib/queries';
import type { Base, TableSummary } from '../../types';

export interface BaseWithTables { base: Base; tables: TableSummary[] }
/** All bases of a workspace with their tables (shares the cache with the sidebar's useTables). */
export function useBaseTables(ws: string): { items: BaseWithTables[]; names: Map<string, string>; loading: boolean } {
  const bases = useBases(ws);
  const tq = useQueries({
    queries: (bases.data ?? []).map((b) => ({ queryKey: qk.tables(b.id), queryFn: async () => (await get<{ tables: TableSummary[] }>(`/bases/${b.id}/tables`)).tables })),
  });
  const items = (bases.data ?? []).map((base, i) => ({ base, tables: tq[i]?.data ?? [] }));
  const names = new Map<string, string>();
  for (const it of items) { names.set(it.base.id, it.base.name); for (const t of it.tables) names.set(t.id, `${it.base.name} / ${t.name}`); }
  return { items, names, loading: bases.isLoading || tq.some((q) => q.isLoading) };
}
