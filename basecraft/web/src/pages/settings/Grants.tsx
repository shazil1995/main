import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, put } from '../../api';
import { ErrorState, Spinner, errText, useToast } from '../../components/ui';
import type { WorkspaceRef } from '../../types';
import type { Member } from './Members';
import { useBaseTables } from './resources';

interface Grant { user_id: string; resource_type: 'base' | 'table'; resource_id: string; role: string }
const GRANT_ROLES = ['none', 'viewer', 'commenter', 'editor', 'admin'];

export function GrantsPanel({ ws, members }: { ws: WorkspaceRef; members: Member[] }) {
  const qc = useQueryClient(); const toast = useToast();
  const { items, names } = useBaseTables(ws.id);
  const list = useQuery({ queryKey: ['grants', ws.id], queryFn: async () => (await get<{ grants: Grant[] }>(`/workspaces/${ws.id}/grants`)).grants });
  const [user, setUser] = useState(''); const [res, setRes] = useState(''); const [role, setRole] = useState('viewer');
  const set = useMutation({
    mutationFn: (b: { user_id: string; resource_type: string; resource_id: string; role: string | null }) => put(`/workspaces/${ws.id}/grants`, b),
    onSuccess: (_r, v) => toast.push('info', v.role === null ? 'Override removed' : 'Override saved'), onError: (e) => toast.push('error', errText(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['grants', ws.id] }),
  });
  const person = (id: string) => members.find((m) => m.user_id === id);
  const eligible = members.filter((m) => m.role !== 'owner');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const [type, id] = res.split(':');
    if (user && type && id) set.mutate({ user_id: user, resource_type: type, resource_id: id, role });
  };
  return (
    <section aria-labelledby="gr-h">
      <h2 id="gr-h">Access overrides</h2>
      <p className="hint">Give one member a different role on a single base or table than their workspace role. Choosing <strong>none</strong> hides the table (or every table in the base) from that person entirely. Owners always have full access.</p>
      <form className="card" onSubmit={submit}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0 }}><label htmlFor="gr-user">Member</label>
            <select id="gr-user" className="select" required value={user} onChange={(e) => setUser(e.target.value)}><option value="">Choose…</option>{eligible.map((m) => <option key={m.user_id} value={m.user_id}>{m.name} ({m.role})</option>)}</select></div>
          <div className="field" style={{ margin: 0 }}><label htmlFor="gr-res">Base or table</label>
            <select id="gr-res" className="select" required value={res} onChange={(e) => setRes(e.target.value)}><option value="">Choose…</option>
              {items.map(({ base, tables }) => (
                <optgroup key={base.id} label={base.name}>
                  <option value={`base:${base.id}`}>Whole base: {base.name}</option>
                  {tables.map((t) => <option key={t.id} value={`table:${t.id}`}>Table: {t.name}</option>)}
                </optgroup>
              ))}</select></div>
          <div className="field" style={{ margin: 0 }}><label htmlFor="gr-role">Role</label>
            <select id="gr-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>{GRANT_ROLES.map((r) => <option key={r} value={r}>{r === 'none' ? 'none (hidden)' : r}</option>)}</select></div>
          <button className="btn primary" disabled={set.isPending}>Save override</button>
        </div>
      </form>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <div className="empty">No overrides.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table-simple">
            <thead><tr><th scope="col">Member</th><th scope="col">Resource</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data!.map((g) => (
                <tr key={`${g.user_id}${g.resource_id}`}>
                  <th scope="row">{person(g.user_id)?.name ?? g.user_id}</th>
                  <td>{g.resource_type === 'base' ? 'Base' : 'Table'}: {names.get(g.resource_id) ?? g.resource_id}</td>
                  <td><span className="badge">{g.role === 'none' ? 'none (hidden)' : g.role}</span></td>
                  <td><button className="btn small danger" disabled={set.isPending} aria-label={`Remove override for ${person(g.user_id)?.name ?? 'member'} on ${names.get(g.resource_id) ?? 'resource'}`} onClick={() => set.mutate({ user_id: g.user_id, resource_type: g.resource_type, resource_id: g.resource_id, role: null })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
