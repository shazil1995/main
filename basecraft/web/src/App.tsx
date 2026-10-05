import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { post, setUnauthorizedHandler } from './api';
import { Dialog, ErrorState, Spinner, useToast, errText } from './components/ui';
import { matchRoute, navigate, tableUrl, useLocation } from './lib/router';
import { qk, useBases, useMe, useTables } from './lib/queries';
import { AuthPage } from './pages/AuthPage';
import type { Base, Me } from './types';
import { ApiError } from './api';

const TablePage = lazy(() => import('./pages/TablePage').then((m) => ({ default: m.TablePage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AutomationsPage = lazy(() => import('./pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));

export function App() {
  const { path, search } = useLocation();
  const route = useMemo(() => matchRoute(path, search), [path, search]);
  const me = useMe();
  const qc = useQueryClient();
  useEffect(() => { setUnauthorizedHandler(() => { qc.setQueryData(qk.me, undefined); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); qc.invalidateQueries({ queryKey: qk.me }); }); }, [qc]);

  const authed = !!me.data;
  useEffect(() => {
    if (me.isLoading) return;
    if (!authed && !['login', 'signup', 'invite'].includes(route.name)) navigate('/login', true);
    if (authed && ['login', 'signup'].includes(route.name)) navigate(`/w/${me.data!.workspaces[0]?.id ?? ''}`, true);
  }, [authed, me.isLoading, route.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me.isLoading) return <Spinner label="Starting" />;
  if (route.name === 'login' || route.name === 'signup') return <AuthPage mode={route.name} />;
  if (route.name === 'invite') return authed ? <AcceptInvite token={route.token} /> : <AuthPage mode="invite" inviteToken={route.token} />;
  if (!authed) return null;
  return <Shell me={me.data!} route={route} />;
}

function AcceptInvite({ token }: { token: string }) {
  const toast = useToast(); const qc = useQueryClient(); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { post('/invitations/accept', { token }).then(async (r) => { await qc.invalidateQueries({ queryKey: qk.me }); navigate(`/w/${r.workspace_id}`, true); }).catch((e) => { setErr(errText(e)); toast.push('error', errText(e)); }); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return err ? <ErrorState error={new Error(err)} /> : <Spinner label="Accepting invitation" />;
}

function Shell({ me, route }: { me: Me; route: ReturnType<typeof matchRoute> }) {
  const wsId = ('ws' in route && route.ws) || me.workspaces[0]?.id;
  const ws = me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0];
  const [navOpen, setNavOpen] = useState(false);
  const qc = useQueryClient();
  const bases = useBases(ws?.id);
  useEffect(() => setNavOpen(false), [route]);
  if (!ws) return <main className="auth"><div className="card"><h2>No workspace</h2><p>Your account is not a member of any workspace. Ask an admin for an invitation.</p></div></main>;
  const logout = async () => { await post('/auth/logout'); qc.clear(); qc.setQueryData(qk.me, undefined); navigate('/login'); };
  const isAdmin = ws.role === 'admin' || ws.role === 'owner';
  return (
    <div className="shell">
      <nav className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Workspaces and tables">
        <div className="brand"><span aria-hidden>▤</span> Basecraft</div>
        <div style={{ padding: '8px 14px' }}>
          <label className="sr-only" htmlFor="ws-select">Workspace</label>
          <select id="ws-select" className="select" value={ws.id} onChange={(e) => navigate(`/w/${e.target.value}`)}>
            {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <h2>Bases</h2>
        {bases.isLoading && <div style={{ padding: '0 14px' }}><div className="skeleton" /></div>}
        {bases.data?.map((b) => <BaseTree key={b.id} base={b} ws={ws.id} role={ws.role} />)}
        {bases.data?.length === 0 && <div className="hint" style={{ padding: '4px 14px' }}>No bases yet.</div>}
        {(isAdmin) && <NewBase ws={ws.id} />}
        <div className="spacer" />
        <h2>Workspace</h2>
        {isAdmin && (['members', 'tokens', 'audit'] as const).map((s) => (
          <a key={s} className="nav-item" href={`/w/${ws.id}/settings/${s}`} aria-current={route.name === 'settings' && route.section === s ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(`/w/${ws.id}/settings/${s}`); }}>{s === 'members' ? 'Members & access' : s === 'tokens' ? 'API tokens' : 'Audit log'}</a>
        ))}
        <a className="nav-item" href={`/w/${ws.id}/settings/account`} aria-current={route.name === 'settings' && route.section === 'account' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(`/w/${ws.id}/settings/account`); }}>Account</a>
        <div style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
          <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.user.name} · {ws.role}</div>
          <button className="btn small" onClick={logout} style={{ marginTop: 6 }}>Sign out</button>
        </div>
      </nav>
      <div className="main">
        <div className="topbar" style={{ display: navOpen || true ? undefined : 'none' }}>
          <button className="btn menu-btn" aria-label="Open navigation" onClick={() => setNavOpen(!navOpen)}>☰</button>
          <strong>{ws.name}</strong>
        </div>
        <Suspense fallback={<Spinner />}>
          {route.name === 'table' && <TablePage key={route.tableId} ws={ws} tableId={route.tableId} viewId={route.viewId} me={me} />}
          {route.name === 'automations' && <AutomationsPage key={route.tableId} ws={ws} tableId={route.tableId} />}
          {route.name === 'settings' && <SettingsPage ws={ws} me={me} section={route.section} />}
          {route.name === 'home' && <Home ws={ws.id} bases={bases.data} loading={bases.isLoading} />}
          {route.name === 'notfound' && <div className="empty">Page not found.</div>}
        </Suspense>
      </div>
    </div>
  );
}

function BaseTree({ base, ws, role }: { base: Base; ws: string; role: string }) {
  const tables = useTables(base.id);
  const { path } = useLocation();
  const [adding, setAdding] = useState(false);
  const canCreate = role === 'admin' || role === 'owner';
  return (
    <div>
      <div className="nav-item" style={{ fontWeight: 600 }}>{base.name}</div>
      {tables.data?.map((t) => (
        <a key={t.id} className="nav-item indent" href={tableUrl(ws, t.id)} aria-current={path.includes(`/t/${t.id}`) ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(tableUrl(ws, t.id)); }}>{t.name}</a>
      ))}
      {canCreate && <button className="nav-item indent muted" onClick={() => setAdding(true)}>+ Add table</button>}
      {adding && <NewTable base={base} ws={ws} onClose={() => setAdding(false)} />}
    </div>
  );
}

function NewBase({ ws }: { ws: string }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(''), [err, setErr] = useState('');
  const qc = useQueryClient();
  return (<>
    <button className="nav-item muted" onClick={() => setOpen(true)}>+ New base</button>
    {open && <Dialog title="New base" onClose={() => setOpen(false)}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await post(`/workspaces/${ws}/bases`, { name }); await qc.invalidateQueries({ queryKey: qk.bases(ws) }); setOpen(false); setName(''); } catch (x) { setErr(errText(x)); } }}>
        <div className="field"><label htmlFor="bn">Name</label><input id="bn" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></div>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary">Create</button></div>
      </form></Dialog>}
  </>);
}

function NewTable({ base, ws, onClose }: { base: Base; ws: string; onClose(): void }) {
  const [name, setName] = useState(''), [err, setErr] = useState('');
  const qc = useQueryClient();
  return (
    <Dialog title={`New table in ${base.name}`} onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { const t = await post(`/bases/${base.id}/tables`, { name }); await qc.invalidateQueries({ queryKey: qk.tables(base.id) }); onClose(); navigate(tableUrl(ws, t.id)); } catch (x) { setErr(errText(x)); } }}>
        <div className="field"><label htmlFor="tn">Table name</label><input id="tn" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></div>
        <p className="hint">A primary “Name” text field is created. Add more fields from the table toolbar.</p>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create table</button></div>
      </form>
    </Dialog>
  );
}

function Home({ ws, bases, loading }: { ws: string; bases?: Base[]; loading: boolean }) {
  if (loading) return <Spinner />;
  return (
    <div className="content">
      <h1>Welcome</h1>
      {!bases?.length ? <p className="muted">This workspace is empty. Create a base from the sidebar to start with a blank table. Developers can also load the fictional signage demo with <code>npm run db:seed</code>.</p>
        : <div className="row wrap">{bases.map((b) => <BaseCard key={b.id} base={b} ws={ws} />)}</div>}
    </div>
  );
}
function BaseCard({ base, ws }: { base: Base; ws: string }) {
  const t = useTables(base.id);
  return <div className="card" style={{ minWidth: 220 }}><h3 style={{ marginTop: 0 }}>{base.name}</h3>{t.data?.map((x) => <div key={x.id}><a href={tableUrl(ws, x.id)} onClick={(e) => { e.preventDefault(); navigate(tableUrl(ws, x.id)); }}>{x.name}</a></div>)}{t.data?.length === 0 && <span className="hint">No tables</span>}</div>;
}
export { ApiError };
