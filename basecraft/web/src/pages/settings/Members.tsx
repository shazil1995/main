import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, type Role } from '@basecraft/shared';
import { del, get, patch } from '../../api';
import { ErrorState, Spinner, errText, useConfirm, useToast } from '../../components/ui';
import { assignableRoles, canManageMember, capabilityMatrix } from '../../lib/adminLogic';
import type { Me, WorkspaceRef } from '../../types';
import { GrantsPanel } from './Grants';
import { InvitationsPanel } from './Invitations';

export interface Member { user_id: string; email: string; name: string; role: Role }
export const useMembers = (ws: string) => useQuery({ queryKey: ['members', ws], queryFn: async () => (await get<{ members: Member[] }>(`/workspaces/${ws}/members`)).members });

export function MembersSection({ ws, me }: { ws: WorkspaceRef; me: Me }) {
  const qc = useQueryClient(); const toast = useToast(); const { confirm, node } = useConfirm();
  const members = useMembers(ws.id);
  const refresh = () => qc.invalidateQueries({ queryKey: ['members', ws.id] });
  const setRole = useMutation({
    mutationFn: (v: { id: string; role: Role }) => patch(`/workspaces/${ws.id}/members/${v.id}`, { role: v.role }),
    onSuccess: () => toast.push('info', 'Role updated'), onError: (e) => toast.push('error', errText(e)), onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/workspaces/${ws.id}/members/${id}`),
    onSuccess: () => { toast.push('info', 'Member removed'); qc.invalidateQueries({ queryKey: ['grants', ws.id] }); }, onError: (e) => toast.push('error', errText(e)), onSettled: refresh,
  });
  const mine = assignableRoles(ws.role);
  return (
    <div style={{ display: 'grid', gap: 22 }}>
      {node}
      <section aria-labelledby="mem-h">
        <h2 id="mem-h">Members</h2>
        {members.isLoading ? <Spinner /> : members.isError ? <ErrorState error={members.error} retry={() => members.refetch()} /> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-simple">
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {members.data!.map((m) => {
                  const can = canManageMember(ws.role, m.role);
                  const opts = mine.includes(m.role) ? mine : [m.role, ...mine];
                  return (
                    <tr key={m.user_id}>
                      <th scope="row">{m.name}{m.user_id === me.user.id && <span className="hint"> (you)</span>}</th>
                      <td>{m.email}</td>
                      <td>
                        <select className="select" style={{ width: 'auto' }} aria-label={`Role for ${m.name}`} value={m.role} disabled={!can || setRole.isPending}
                          onChange={(e) => setRole.mutate({ id: m.user_id, role: e.target.value as Role })}>
                          {opts.map((r) => <option key={r} value={r} disabled={!mine.includes(r)}>{r}</option>)}
                        </select>
                      </td>
                      <td>
                        <button className="btn small danger" disabled={!can} aria-label={`Remove ${m.name}`}
                          onClick={async () => { if (await confirm(`Remove ${m.name} (${m.email}) from this workspace? Their access overrides are deleted too.`, 'Remove')) remove.mutate(m.user_id); }}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">You can only change or remove people below your own role{ws.role === 'owner' ? ' (owners can manage everyone, but a workspace must keep at least one owner)' : ''}.</p>
      </section>
      <InvitationsPanel ws={ws} />
      <GrantsPanel ws={ws} members={members.data ?? []} />
      <PermissionMatrix />
    </div>
  );
}

function PermissionMatrix() {
  const rows = capabilityMatrix();
  return (
    <section aria-labelledby="mx-h">
      <h2 id="mx-h">What each role can do</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="table-simple matrix">
          <thead><tr><th scope="col">Capability</th>{ROLES.map((r) => <th scope="col" key={r}>{r}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}><th scope="row">{r.label}</th>
                {ROLES.map((role) => <td key={role} aria-label={r.roles[role] ? 'Allowed' : 'Not allowed'}>{r.roles[role] ? '✓' : '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Each role includes everything the roles to its left can do. Only owners can rename the workspace or assign the owner role.</p>
    </section>
  );
}
