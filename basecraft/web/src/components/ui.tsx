import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

// ───────── toasts ─────────
interface Toast { id: number; kind: 'info' | 'error'; text: string }
const ToastCtx = createContext<{ push(kind: Toast['kind'], text: string): void }>({ push() {} });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const errText = (e: unknown): string => {
  if (e instanceof ApiError) {
    const fe = Object.values(e.fieldErrors);
    return fe.length ? `${e.message}: ${fe.slice(0, 3).join('; ')}` : e.message + (e.traceId && e.status >= 500 ? ` (trace ${e.traceId})` : '');
  }
  return e instanceof Error ? e.message : 'Something went wrong';
};

// ───────── dialog (focus trap + Escape) ─────────
export function Dialog({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    (el.querySelector<HTMLElement>('[autofocus], input, select, textarea, button') ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = [...el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ───────── popover anchored under a trigger ─────────
export function Popover({ label, children, buttonClass = 'btn', open: ctrl, onOpenChange, badge }: { label: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); buttonClass?: string; open?: boolean; onOpenChange?(o: boolean): void; badge?: ReactNode }) {
  const [inner, setInner] = useState(false);
  const open = ctrl ?? inner;
  const set = (o: boolean) => { setInner(o); onOpenChange?.(o); };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) set(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { set(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className={buttonClass} aria-haspopup="dialog" aria-expanded={open} onClick={() => set(!open)}>{label}{badge}</button>
      {open && <div className="popover" role="dialog" style={{ top: '100%', left: 0, marginTop: 4 }}>{typeof children === 'function' ? children(() => set(false)) : children}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="empty" role="status" aria-live="polite"><div className="skeleton" style={{ width: 180, margin: '0 auto 8px' }} />{label}…</div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry?(): void }) {
  return (
    <div className="empty" role="alert">
      <div className="err">{errText(error)}</div>
      {retry && <button className="btn" style={{ marginTop: 10 }} onClick={retry}>Try again</button>}
    </div>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ text: string; ok: string; resolve(v: boolean): void } | null>(null);
  const confirm = useCallback((text: string, ok = 'Delete') => new Promise<boolean>((resolve) => setState({ text, ok, resolve })), []);
  const node = state && (
    <Dialog title="Please confirm" onClose={() => { state.resolve(false); setState(null); }}>
      <p>{state.text}</p>
      <div className="row"><span className="spacer" />
        <button className="btn" onClick={() => { state.resolve(false); setState(null); }}>Cancel</button>
        <button className="btn danger" onClick={() => { state.resolve(true); setState(null); }}>{state.ok}</button>
      </div>
    </Dialog>
  );
  return { confirm, node };
}
