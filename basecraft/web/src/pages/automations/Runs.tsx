import { useQuery } from '@tanstack/react-query';
import { get } from '../../api';
import { ErrorState, Spinner } from '../../components/ui';
import { metaSummary } from '../../lib/adminLogic';
import { formatDateTime } from '../../lib/format';

interface Run { id: string; status: 'success' | 'failed' | 'skipped' | 'test' | string; test_mode: boolean; attempts: number | null; started_at: string; duration_ms: number | null; input: unknown; error: string | null }

export function RunsPanel({ automationId }: { automationId: string }) {
  // react-query clears the interval when the panel unmounts
  const q = useQuery({ queryKey: ['autoRuns', automationId], queryFn: async () => (await get<{ runs: Run[] }>(`/automations/${automationId}/runs?limit=50`)).runs, refetchInterval: 5000 });
  return (
    <div>
      <p className="hint">Refreshes every 5 seconds. Delivery is at-least-once: a failed run is retried with exponential backoff and, after the maximum number of attempts, is dead-lettered (stays “failed”). Runs that would loop or nest too deeply are “skipped”, with the reason in the error column. Inputs show ids only, never record values.</p>
      <div aria-live="polite">
        {q.isLoading ? <Spinner label="Loading runs" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : q.data!.length === 0 ? <div className="empty">No runs yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-simple">
              <caption className="sr-only">Run history</caption>
              <thead><tr><th scope="col">Status</th><th scope="col">Test</th><th scope="col">Attempts</th><th scope="col">Duration</th><th scope="col">Started</th><th scope="col">Error</th><th scope="col">Input</th></tr></thead>
              <tbody>
                {q.data!.map((r) => (
                  <tr key={r.id}>
                    <td><span className={`badge st-${r.status}`}>{r.status}</span></td>
                    <td>{r.test_mode ? 'Yes' : 'No'}</td>
                    <td>{r.attempts ?? '—'}</td>
                    <td>{r.duration_ms !== null ? `${r.duration_ms} ms` : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.started_at)}</td>
                    <td className={r.error ? 'err' : ''}>{r.error ?? ''}</td>
                    <td className="mono hint" style={{ wordBreak: 'break-all' }}>{metaSummary(r.input, 120)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
