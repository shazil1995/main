import { useState } from 'react';
import { post } from '../../api';
import { errText, useToast } from '../../components/ui';
import type { Me } from '../../types';

export function AccountSection({ me }: { me: Me }) {
  const toast = useToast();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (next.length < 10) return setErr('The new password must be at least 10 characters.');
    if (next !== again) return setErr('The new passwords do not match.');
    setBusy(true);
    try { await post('/auth/change-password', { current_password: cur, new_password: next }); toast.push('info', 'Password changed. Other sessions were signed out.'); setCur(''); setNext(''); setAgain(''); }
    catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
      <section className="card" aria-labelledby="acct-h">
        <h2 id="acct-h" style={{ marginTop: 0 }}>Your profile</h2>
        <dl className="kv"><dt>Name</dt><dd>{me.user.name}</dd><dt>Email</dt><dd>{me.user.email}</dd></dl>
      </section>
      <form className="card" onSubmit={submit} aria-labelledby="pw-h">
        <h2 id="pw-h" style={{ marginTop: 0 }}>Change password</h2>
        <p className="hint">Changing your password signs you out of all your other sessions.</p>
        <div className="field"><label htmlFor="pw-cur">Current password</label><input id="pw-cur" className="input" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw-new">New password (at least 10 characters)</label><input id="pw-new" className="input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw-again">Repeat new password</label><input id="pw-again" className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <div role="alert" className="err">{err}</div>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </div>
  );
}
