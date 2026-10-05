import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { ApiError, del, get, patch, post } from '../api';
import type { ApiRecord, Base, Me, RecordQuery, RecordsPage, TableDetail, TableSummary, View } from '../types';

export const qk = {
  me: ['me'] as const,
  bases: (ws: string) => ['bases', ws] as const,
  tables: (base: string) => ['tables', base] as const,
  table: (id: string) => ['table', id] as const,
  views: (tableId: string) => ['views', tableId] as const,
  records: (tableId: string, key: unknown) => ['records', tableId, key] as const,
  recordsAll: (tableId: string) => ['records', tableId] as const,
  record: (id: string) => ['record', id] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => get<Me>('/auth/me'), retry: false, staleTime: 60_000 });
export const useBases = (ws?: string) => useQuery({ queryKey: qk.bases(ws ?? ''), enabled: !!ws, queryFn: async () => (await get<{ bases: Base[] }>(`/workspaces/${ws}/bases`)).bases });
export const useTables = (base?: string) => useQuery({ queryKey: qk.tables(base ?? ''), enabled: !!base, queryFn: async () => (await get<{ tables: TableSummary[] }>(`/bases/${base}/tables`)).tables });
export const useTable = (id?: string) => useQuery({ queryKey: qk.table(id ?? ''), enabled: !!id, queryFn: () => get<TableDetail>(`/tables/${id}`) });
export const useViews = (tableId?: string) => useQuery({ queryKey: qk.views(tableId ?? ''), enabled: !!tableId, queryFn: async () => (await get<{ views: View[] }>(`/tables/${tableId}/views`)).views });

export const PAGE_SIZE = 100;
/** Cached pages per query. 8 x 100 rows bounds browser memory regardless of table size (older pages are dropped and refetched via prev_cursor). */
export const MAX_PAGES = 8;

export interface RecordsOptions { pageSize?: number; enabled?: boolean; includeTotal?: boolean; maxPages?: number; fields?: string[] }

/**
 * The ONE way views load records: server-side search/filter/sort with cursor pagination and a bounded page window.
 * Grid, board columns, gallery, calendar and form views all go through this hook (same record source).
 */
export function useRecords(tableId: string, query: RecordQuery, opts: RecordsOptions = {}) {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const key = useMemo(() => ({ q: query, pageSize, fields: opts.fields ?? null }), [query, pageSize, opts.fields]);
  const body = (cursor?: string) => ({
    search: query.search || undefined, filter: query.filter, sort: query.sort?.length ? query.sort : undefined,
    limit: pageSize, cursor, include_total: opts.includeTotal ?? false, fields: opts.fields,
  });
  const q = useInfiniteQuery<RecordsPage, ApiError, InfiniteData<RecordsPage, string | undefined>, ReturnType<typeof qk.records>, string | undefined>({
    queryKey: qk.records(tableId, key),
    enabled: opts.enabled ?? true,
    initialPageParam: undefined,
    maxPages: opts.maxPages ?? MAX_PAGES,
    queryFn: ({ pageParam, signal }) => post<RecordsPage>(`/tables/${tableId}/records/query`, body(pageParam), { signal }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    getPreviousPageParam: (first) => first.prev_cursor ?? undefined,
    placeholderData: (prev) => prev, // keep rows on screen while a new filter/sort loads (no focus-stealing flash)
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.records), [q.data]);
  const total = q.data?.pages[0]?.total;
  return { ...q, rows, total, totalCapped: q.data?.pages[0]?.total_capped ?? false };
}

type Pages = InfiniteData<RecordsPage, string | undefined>;
/** Apply `fn` to the cached copy of a record in every cached query of this table (optimistic updates). */
export function patchRecordInCache(qc: ReturnType<typeof useQueryClient>, tableId: string, id: string, fn: (r: ApiRecord) => ApiRecord) {
  qc.setQueriesData<Pages>({ queryKey: qk.recordsAll(tableId) }, (old) => old && {
    ...old, pages: old.pages.map((p) => (p.records.some((r) => r.id === id) ? { ...p, records: p.records.map((r) => (r.id === id ? fn(r) : r)) } : p)),
  });
}
export function removeRecordsFromCache(qc: ReturnType<typeof useQueryClient>, tableId: string, ids: Set<string>) {
  qc.setQueriesData<Pages>({ queryKey: qk.recordsAll(tableId) }, (old) => old && { ...old, pages: old.pages.map((p) => ({ ...p, records: p.records.filter((r) => !ids.has(r.id)), total: p.total !== undefined ? Math.max(0, p.total - p.records.filter((r) => ids.has(r.id)).length) : p.total })) });
}

export interface CellEdit { record: ApiRecord; fieldId: string; value: unknown }

/** Mutations shared by every view. They keep the cache consistent and surface 412 conflicts to the caller. */
export function useRecordMutations(tableId: string) {
  const qc = useQueryClient();
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: qk.recordsAll(tableId) }), [qc, tableId]);

  /** Optimistic single-cell edit. Resolves with the saved record; rejects with ApiError (412 => err.details.current is the server copy). */
  const updateCell = useCallback(async (e: CellEdit): Promise<ApiRecord> => {
    const before = e.record;
    patchRecordInCache(qc, tableId, before.id, (r) => {
      const fields = { ...r.fields };
      if (e.value === null || e.value === undefined) delete fields[e.fieldId]; else fields[e.fieldId] = e.value;
      return { ...r, fields };
    });
    try {
      const saved = await patch<ApiRecord>(`/records/${before.id}`, { fields: { [e.fieldId]: e.value } }, { headers: { 'if-match': `"${before.version}"` } });
      patchRecordInCache(qc, tableId, before.id, () => saved);
      qc.setQueryData(qk.record(before.id), saved);
      return saved;
    } catch (err) {
      patchRecordInCache(qc, tableId, before.id, () => err instanceof ApiError && err.status === 412 ? (err.details?.current ?? before) : before);
      throw err;
    }
  }, [qc, tableId]);

  const updateMany = useCallback(async (ops: { id: string; version: number; fields: Record<string, unknown> }[]) => {
    const r = await post<{ results: { record: ApiRecord }[] }>(`/tables/${tableId}/records/batch`, { operations: ops.map((o) => ({ op: 'update', ...o })) });
    for (const x of r.results) patchRecordInCache(qc, tableId, x.record.id, () => x.record);
    return r.results.map((x) => x.record);
  }, [qc, tableId]);

  const create = useCallback(async (fields: Record<string, unknown>) => {
    const rec = await post<ApiRecord>(`/tables/${tableId}/records`, { fields }, { headers: { 'idempotency-key': crypto.randomUUID() } });
    await invalidate();
    return rec;
  }, [tableId, invalidate]);

  const remove = useCallback(async (recs: { id: string; version: number }[]) => {
    await post(`/tables/${tableId}/records/batch`, { operations: recs.map((r) => ({ op: 'delete', id: r.id, version: r.version })) });
    removeRecordsFromCache(qc, tableId, new Set(recs.map((r) => r.id)));
    qc.removeQueries({ queryKey: ['record'], predicate: (q) => recs.some((r) => q.queryKey[1] === r.id) });
  }, [qc, tableId]);

  return { updateCell, updateMany, create, remove, invalidate };
}

export const useRecord = (id?: string) => useQuery({ queryKey: qk.record(id ?? ''), enabled: !!id, queryFn: () => get<ApiRecord>(`/records/${id}`) });

export function useSaveView(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id?: string; name: string; type: string; visibility: string; config: unknown; version?: number }) =>
      v.id ? patch<View>(`/views/${v.id}`, { name: v.name, visibility: v.visibility, config: v.config, version: v.version }) : post<View>(`/tables/${tableId}/views`, { name: v.name, type: v.type, visibility: v.visibility, config: v.config }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.views(tableId) }),
  });
}
