import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from '../../api';
import { ErrorState, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { metaSummary } from '../../lib/adminLogic';
import type { WorkspaceRef } from '../../types';

interface AuditEvent { id: number; actor_type: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; metadata: unknown; created_at: string }
interface AuditPage { events: AuditEvent[]; next_before: number | null }

export function AuditSection({ ws }: { ws: WorkspaceRef }) {
  const [input, setInput] = useState(''); const [prefix, setPrefix] = useState('');
  useEffect(() => { const t = setTimeout(() => setPrefix(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  const q = useInfiniteQuery<AuditPage, Error, { pages: AuditPage[] }, unknown[], number | undefined>({
    queryKey: ['audit', ws.id, prefix], initialPageParam: undefined,
    queryFn: ({ pageParam }) => get<AuditPage>(`/workspaces/${ws.id}/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}${prefix ? `&action=${encodeURIComponent(prefix)}` : ''}`),
    getNextPageParam: (l) => l.next_before ?? undefined,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <div>
      <p className="hint">An append-only record of sensitive actions, newest first.</p>
      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor="audit-filter">Filter by action prefix (for example “member.” or “token.”)</label>
        <input id="audit-filter" className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="member." />
      </div>
      {q.isLoading ? <Spinner label="Loading audit log" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="table-simple">
              <caption className="sr-only">Audit events</caption>
              <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.created_at)}</td>
                    <td><span className="badge">{e.actor_type}</span> <span className="mono hint">{e.actor_id ?? ''}</span></td>
                    <td><code>{e.action}</code></td>
                    <td className="mono hint">{e.target_type ? `${e.target_type} ${e.target_id ?? ''}` : ''}</td>
                    <td className="mono hint" style={{ wordBreak: 'break-all' }}>{metaSummary(e.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {events.length === 0 && <div className="empty">No audit events{prefix ? ` match “${prefix}”` : ' yet'}.</div>}
          {q.hasNextPage && <div style={{ marginTop: 12 }}><button className="btn" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load older'}</button></div>}
        </>
      )}
    </div>
  );
}
