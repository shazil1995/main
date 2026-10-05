import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TOKEN_ALLOWED_SCOPES } from '@basecraft/shared';
import { useState } from 'react';
import { del, get, post } from '../../api';
import { ErrorState, Spinner, errText, useConfirm, useToast } from '../../components/ui';
import { TOKEN_SCOPE_LABELS, parseDays, tokenStatus } from '../../lib/adminLogic';
import { formatDateTime } from '../../lib/format';
import type { WorkspaceRef } from '../../types';
import { SecretDialog } from './Secret';
import { useBaseTables } from './resources';

interface Tok { id: string; name: string; prefix: string; scopes: string[]; base_ids: string[] | null; table_ids: string[] | null; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null }

export function TokensSection({ ws }: { ws: WorkspaceRef }) {
  const qc = useQueryClient(); const toast = useToast(); const { confirm, node } = useConfirm();
  const { names } = useBaseTables(ws.id);
  const list = useQuery({ queryKey: ['tokens', ws.id], queryFn: async () => (await get<{ tokens: Tok[] }>(`/workspaces/${ws.id}/tokens`)).tokens });
  const [secret, setSecret] = useState<{ title: string; token: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens', ws.id] });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/tokens/${id}`), onSuccess: () => { toast.push('info', 'Token revoked'); refresh(); }, onError: (e) => toast.push('error', errText(e)) });
  const rotate = useMutation({
    mutationFn: (id: string) => post<{ token: string }>(`/tokens/${id}/rotate`),
    onSuccess: (r) => { setSecret({ title: 'Token rotated', token: r.token }); refresh(); }, onError: (e) => toast.push('error', errText(e)),
  });
  const restriction = (t: Tok) => {
    const ids = [...(t.table_ids ?? []), ...(t.base_ids ?? [])];
    return ids.length ? ids.map((i) => names.get(i) ?? 'unknown').join(', ') : 'Whole workspace';
  };
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {node}
      {secret && <SecretDialog title={secret.title} label="API token" value={secret.token} warning="Shown once. Copy it now: Basecraft cannot show this token again." onClose={() => setSecret(null)} />}
      <section className="card" aria-labelledby="usage-h">
        <h2 id="usage-h" style={{ marginTop: 0 }}>Using the API</h2>
        <pre className="code" tabIndex={0}>{`curl -H "Authorization: Bearer <token>" \\\n  ${location.origin}/api/v1/tables/<table-id>/records`}</pre>
        <p className="hint">Full reference: <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">/api/v1/openapi.json</a>. Tokens can never manage members, tokens, automations or schema. They act within the scopes you choose and (optionally) only on the tables you pick.</p>
      </section>
      <CreateToken ws={ws} onCreated={(t) => { setSecret({ title: 'Token created', token: t }); refresh(); }} />
      <section aria-labelledby="tok-h">
        <h2 id="tok-h">Existing tokens</h2>
        {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <div className="empty">No API tokens yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-simple">
              <thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Scopes</th><th scope="col">Restricted to</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.data!.map((t) => {
                  const st = tokenStatus(t);
                  return (
                    <tr key={t.id}>
                      <th scope="row">{t.name}</th>
                      <td className="mono">{t.prefix}…</td>
                      <td>{t.scopes.map((s) => <span key={s} className="badge" style={{ marginRight: 4 }}>{s}</span>)}</td>
                      <td>{restriction(t)}</td>
                      <td>{formatDateTime(t.created_at)}</td>
                      <td>{t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}</td>
                      <td>{t.expires_at ? formatDateTime(t.expires_at) : 'Never'}</td>
                      <td><span className="badge">{st}</span></td>
                      <td>
                        {st !== 'revoked' && (
                          <div className="row">
                            <button className="btn small" disabled={rotate.isPending} aria-label={`Rotate token ${t.name}`} onClick={async () => { if (await confirm(`Rotate “${t.name}”? The current token stops working immediately and a new one is issued.`, 'Rotate')) rotate.mutate(t.id); }}>Rotate</button>
                            <button className="btn small danger" aria-label={`Revoke token ${t.name}`} onClick={async () => { if (await confirm(`Revoke “${t.name}”? Anything using it will stop working.`, 'Revoke')) revoke.mutate(t.id); }}>Revoke</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CreateToken({ ws, onCreated }: { ws: WorkspaceRef; onCreated(token: string): void }) {
  const toast = useToast(); const { items } = useBaseTables(ws.id);
  const [name, setName] = useState(''); const [scopes, setScopes] = useState<string[]>(['records:read']);
  const [tables, setTables] = useState<string[]>([]); const [days, setDays] = useState(''); const [err, setErr] = useState<string | null>(null);
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const create = useMutation({
    mutationFn: (b: unknown) => post<{ token: string }>(`/workspaces/${ws.id}/tokens`, b),
    onSuccess: (r) => { onCreated(r.token); setName(''); setScopes(['records:read']); setTables([]); setDays(''); },
    onError: (e) => toast.push('error', errText(e)),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const d = parseDays(days, 1, 365);
    if (d === undefined) return setErr('Expiry must be a whole number of days from 1 to 365, or blank for never.');
    if (!scopes.length) return setErr('Choose at least one scope.');
    create.mutate({ name: name.trim(), scopes, table_ids: tables.length ? tables : null, expires_in_days: d });
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="newtok-h">
      <h2 id="newtok-h" style={{ marginTop: 0 }}>Create a token</h2>
      <div className="field" style={{ maxWidth: 360 }}><label htmlFor="tok-name">Name</label><input id="tok-name" className="input" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly sync" /></div>
      <fieldset className="fs"><legend>Scopes</legend>
        <div className="grid-2">{TOKEN_ALLOWED_SCOPES.map((s) => (
          <label key={s} className="row"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(toggle(scopes, s, e.target.checked))} /> {TOKEN_SCOPE_LABELS[s] ?? s} <code className="hint">{s}</code></label>
        ))}</div>
      </fieldset>
      <fieldset className="fs"><legend>Restrict to tables (optional)</legend>
        <p className="hint">Leave all unchecked for access to the whole workspace.</p>
        {items.map(({ base, tables: ts }) => (
          <div key={base.id}><strong>{base.name}</strong>
            <div className="grid-2">{ts.map((t) => <label key={t.id} className="row"><input type="checkbox" checked={tables.includes(t.id)} onChange={(e) => setTables(toggle(tables, t.id, e.target.checked))} /> {t.name}</label>)}</div>
          </div>
        ))}
      </fieldset>
      <div className="field" style={{ maxWidth: 240 }}><label htmlFor="tok-days">Expires after (days, blank = never)</label><input id="tok-days" className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></div>
      <div role="alert" className="err">{err}</div>
      <button className="btn primary" disabled={create.isPending || !name.trim()}>{create.isPending ? 'Creating…' : 'Create token'}</button>
    </form>
  );
}
