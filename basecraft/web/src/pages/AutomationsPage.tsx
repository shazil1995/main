import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { permissionsForRole } from '@basecraft/shared';
import { useState } from 'react';
import { del, get, patch } from '../api';
import { ErrorState, Spinner, errText, useConfirm, useToast } from '../components/ui';
import { triggerSummary, type ApiAutomation } from '../lib/automationLogic';
import { navigate } from '../lib/router';
import { useTable } from '../lib/queries';
import type { WorkspaceRef } from '../types';
import { Builder } from './automations/Builder';
import { RunsPanel } from './automations/Runs';
import { TestPanel } from './automations/TestPanel';

export function AutomationsPage({ ws, tableId }: { ws: WorkspaceRef; tableId: string }) {
  const table = useTable(tableId);
  const qc = useQueryClient(); const toast = useToast(); const { confirm, node } = useConfirm();
  const perms = table.data ? permissionsForRole(table.data.role) : null;
  const canRead = !!perms?.has('automations:read'), canWrite = !!perms?.has('automations:write');
  const list = useQuery({ queryKey: ['automations', tableId], enabled: canRead, queryFn: async () => (await get<{ automations: ApiAutomation[] }>(`/tables/${tableId}/automations`)).automations });
  const [editing, setEditing] = useState<ApiAutomation | 'new' | null>(null);
  const [open, setOpen] = useState<{ id: string; panel: 'runs' | 'test' } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['automations', tableId] });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => patch(`/automations/${v.id}`, { enabled: v.enabled }), onError: (e) => toast.push('error', errText(e)), onSettled: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/automations/${id}`), onSuccess: () => toast.push('info', 'Automation deleted'), onError: (e) => toast.push('error', errText(e)), onSettled: refresh });

  const back = <a href={`/w/${ws.id}/t/${tableId}`} onClick={(e) => { e.preventDefault(); navigate(`/w/${ws.id}/t/${tableId}`); }}>← Back to {table.data?.name ?? 'table'}</a>;
  if (table.isLoading) return <Spinner />;
  if (table.isError) return <ErrorState error={table.error} retry={() => table.refetch()} />;
  const t = table.data!;
  if (!canRead) return <div className="content"><div>{back}</div><div className="banner warn" role="alert"><strong>You need editor access</strong> to see automations on this table.</div></div>;
  const fieldName = (id: string) => t.fields.find((f) => f.id === id)?.name ?? 'unknown field';

  return (
    <div className="content">
      {node}
      {editing && <Builder ws={ws.id} tableId={tableId} fields={t.fields} existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <div className="row wrap" style={{ marginBottom: 8 }}>{back}</div>
      <div className="row wrap">
        <h1 style={{ margin: 0 }}>Automations: {t.name}</h1><span className="spacer" />
        {canWrite && <button className="btn primary" onClick={() => setEditing('new')}>New automation</button>}
      </div>
      {!canWrite && <div className="banner">You can see automations but only admins can change, delete or test them.</div>}
      <p className="hint">Automations run on the server when records change. This version can only update records or create records in other tables. There are no outgoing HTTP or email actions yet: those need stored credentials, an approval step and SSRF protection, and are planned.</p>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <div className="empty">No automations on this table yet.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table-simple">
            <thead><tr><th scope="col">Name</th><th scope="col">Trigger</th><th scope="col">Actions</th><th scope="col">Enabled</th><th scope="col"><span className="sr-only">Controls</span></th></tr></thead>
            <tbody>
              {list.data!.flatMap((a) => {
                const isOpen = open?.id === a.id;
                const rows = [
                  <tr key={a.id}>
                    <th scope="row">{a.name}</th>
                    <td>{triggerSummary(a, fieldName)}</td>
                    <td>{a.actions.length}</td>
                    <td><label className="row"><input type="checkbox" role="switch" disabled={!canWrite || toggle.isPending} checked={a.enabled} aria-label={`Enabled: ${a.name}`} onChange={(e) => toggle.mutate({ id: a.id, enabled: e.target.checked })} /> {a.enabled ? 'On' : 'Off'}</label></td>
                    <td><div className="row wrap">
                      <button className="btn small" aria-expanded={isOpen && open!.panel === 'runs'} onClick={() => setOpen(isOpen && open!.panel === 'runs' ? null : { id: a.id, panel: 'runs' })}>Runs</button>
                      {canWrite && <button className="btn small" aria-expanded={isOpen && open!.panel === 'test'} onClick={() => setOpen(isOpen && open!.panel === 'test' ? null : { id: a.id, panel: 'test' })}>Test</button>}
                      {canWrite && <button className="btn small" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>Edit</button>}
                      {canWrite && <button className="btn small danger" aria-label={`Delete ${a.name}`} onClick={async () => { if (await confirm(`Delete “${a.name}” and its run history?`)) remove.mutate(a.id); }}>Delete</button>}
                    </div></td>
                  </tr>,
                ];
                if (isOpen) rows.push(<tr key={a.id + 'p'}><td colSpan={5}>{open!.panel === 'runs' ? <RunsPanel automationId={a.id} /> : <TestPanel automation={a} table={t} />}</td></tr>);
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
