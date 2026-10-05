import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { errText } from '../components/ui';
import { navigate } from '../lib/router';
import { qk } from '../lib/queries';

export function AuthPage({ mode, inviteToken }: { mode: 'login' | 'signup' | 'invite'; inviteToken?: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [ws, setWs] = useState('');
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const signup = mode !== 'login';
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = signup
        ? await post('/auth/signup', { email, name, password, ...(ws ? { workspace_name: ws } : {}), ...(inviteToken ? { invite_token: inviteToken } : {}) })
        : await post('/auth/login', { email, password });
      qc.setQueryData(qk.me, r);
      navigate(`/w/${r.workspaces[0]?.id ?? ''}`, true);
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  return (
    <main className="auth">
      <h1 style={{ marginBottom: 4 }}>Basecraft</h1>
      <p className="muted" style={{ marginTop: 0 }}>{mode === 'login' ? 'Sign in to your workspace' : mode === 'invite' ? 'Create your account to accept the invitation' : 'Create an account'}</p>
      <form className="card" onSubmit={submit} aria-label={signup ? 'Sign up' : 'Sign in'}>
        {signup && <div className="field"><label htmlFor="name">Your name</label><input id="name" className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" required minLength={signup ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} aria-describedby="pw-hint" />
          {signup && <span id="pw-hint" className="hint">At least 10 characters.</span>}</div>
        {signup && mode === 'signup' && <div className="field"><label htmlFor="ws">Workspace name (optional)</label><input id="ws" className="input" value={ws} onChange={(e) => setWs(e.target.value)} /></div>}
        {err && <div className="banner error" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="muted" style={{ textAlign: 'center' }}>
        {mode === 'login' ? <>New here? <a href="/signup" onClick={(e) => { e.preventDefault(); navigate('/signup'); }}>Create an account</a></> : mode === 'signup' ? <>Have an account? <a href="/login" onClick={(e) => { e.preventDefault(); navigate('/login'); }}>Sign in</a></> : null}
      </p>
    </main>
  );
}
