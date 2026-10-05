import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@basecraft/shared';
import { useState } from 'react';
import { del, get, post } from '../../api';
import { ErrorState, Spinner, errText, useConfirm, useToast } from '../../components/ui';
import { inviteLink, inviteStatus, invitableRoles, parseDays } from '../../lib/adminLogic';
import { formatDateTime } from '../../lib/format';
import type { WorkspaceRef } from '../../types';
import { SecretDialog } from './Secret';

interface Inv { id: string; email: string; role: Role; created_at: string; expires_at: string; revoked_at: string | null; accepted_at: string | null }

export function InvitationsPanel({ ws }: { ws: WorkspaceRef }) {
  const qc = useQueryClient(); const toast = useToast(); const { confirm, node } = useConfirm();
  const roles = invitableRoles(ws.role);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Role>(roles.includes('editor') ? 'editor' : roles[roles.length - 1] ?? 'viewer');
  const [days, setDays] = useState('7'); const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; email: string } | null>(null);
  const list = useQuery({ queryKey: ['invitations', ws.id], queryFn: async () => (await get<{ invitations: Inv[] }>(`/workspaces/${ws.id}/invitations`)).invitations });
  const refresh = () => qc.invalidateQueries({ queryKey: ['invitations', ws.id] });
  const create = useMutation({
    mutationFn: (b: unknown) => post<{ token: string; email: string }>(`/workspaces/${ws.id}/invitations`, b),
    onSuccess: (r) => { setLink({ link: inviteLink(location.origin, r.token), email: r.email }); setEmail(''); refresh(); },
    onError: (e) => toast.push('error', errText(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/invitations/${id}`), onSuccess: () => toast.push('info', 'Invitation revoked'), onError: (e) => toast.push('error', errText(e)), onSettled: refresh });
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const d = parseDays(days, 1, 30);
    if (d === undefined || d === null) return setErr('Expiry must be a whole number of days from 1 to 30.');
    create.mutate({ email: email.trim(), role, expires_in_days: d });
  };
  return (
    <section aria-labelledby="inv-h">
      {node}
      {link && (
        <SecretDialog title="Invitation link" label={`Invite link for ${link.email}`} value={link.link} warning="Shown once. Basecraft does not send email — share it yourself." onClose={() => setLink(null)}>
          <p>Send this link to <strong>{link.email}</strong>. They must sign in (or sign up) with that same email address to accept it.</p>
        </SecretDialog>
      )}
      <h2 id="inv-h">Invitations</h2>
      <form className="card" onSubmit={submit}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0, minWidth: 220 }}><label htmlFor="inv-email">Email</label><input id="inv-email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label htmlFor="inv-role">Role</label>
            <select id="inv-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
          <div className="field" style={{ margin: 0, width: 120 }}><label htmlFor="inv-days">Expires (days)</label><input id="inv-days" className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></div>
          <button className="btn primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create invitation'}</button>
        </div>
        <div role="alert" className="err">{err}</div>
        <p className="hint" style={{ marginBottom: 0 }}>You can invite at roles below your own. Nothing is emailed: you get a one-time link to share yourself.</p>
      </form>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <div className="empty">No invitations yet.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table-simple">
            <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data!.map((i) => {
                const st = inviteStatus(i);
                return (
                  <tr key={i.id}><th scope="row">{i.email}</th><td>{i.role}</td><td><span className="badge">{st}</span></td><td>{formatDateTime(i.expires_at)}</td>
                    <td>{st === 'pending' && <button className="btn small danger" aria-label={`Revoke invitation for ${i.email}`} onClick={async () => { if (await confirm(`Revoke the invitation for ${i.email}?`, 'Revoke')) revoke.mutate(i.id); }}>Revoke</button>}</td></tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
