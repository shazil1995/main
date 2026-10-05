import { useState, type ReactNode } from 'react';
import { Dialog } from '../../components/ui';

/** Shows a secret exactly once. The parent must clear its copy of the value in onClose. */
export function SecretDialog({ title, label, value, warning, onClose, children }: { title: string; label: string; value: string; warning: string; onClose(): void; children?: ReactNode }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied('yes'); } catch { setCopied('no'); }
  };
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="banner warn" role="alert"><strong>{warning}</strong></div>
      {children}
      <div className="field">
        <label htmlFor="secret-value">{label}</label>
        <input id="secret-value" className="input mono" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <div className="row">
        <button className="btn primary" onClick={copy}>Copy</button>
        <span className="hint" role="status" aria-live="polite">{copied === 'yes' ? 'Copied to clipboard.' : copied === 'no' ? 'Copy failed: select the text above and copy it manually.' : ''}</span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>I have saved it, close</button>
      </div>
    </Dialog>
  );
}
