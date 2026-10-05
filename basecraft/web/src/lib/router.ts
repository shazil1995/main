import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const snapshot = () => window.location.pathname + window.location.search;
const subscribe = (fn: () => void) => { listeners.add(fn); window.addEventListener('popstate', fn); return () => { listeners.delete(fn); window.removeEventListener('popstate', fn); }; };

export function navigate(to: string, replace = false) {
  if (to === snapshot()) return;
  (replace ? history.replaceState : history.pushState).call(history, {}, '', to);
  listeners.forEach((l) => l());
}
export function useLocation(): { path: string; search: URLSearchParams } {
  const s = useSyncExternalStore(subscribe, snapshot);
  const [path, q = ''] = s.split('?');
  return { path: path!, search: new URLSearchParams(q) };
}

export type Route =
  | { name: 'login' } | { name: 'signup' } | { name: 'invite'; token: string }
  | { name: 'home'; ws?: string }
  | { name: 'table'; ws: string; tableId: string; viewId?: string }
  | { name: 'automations'; ws: string; tableId: string }
  | { name: 'settings'; ws: string; section: string }
  | { name: 'notfound' };

export function matchRoute(path: string, search: URLSearchParams): Route {
  const p = path.replace(/\/+$/, '') || '/';
  let m: RegExpExecArray | null;
  if (p === '/login') return { name: 'login' };
  if (p === '/signup') return { name: 'signup' };
  if (p === '/invite') return { name: 'invite', token: search.get('token') ?? '' };
  if (p === '/') return { name: 'home' };
  if ((m = /^\/w\/([^/]+)$/.exec(p))) return { name: 'home', ws: m[1] };
  if ((m = /^\/w\/([^/]+)\/t\/([^/]+)\/automations$/.exec(p))) return { name: 'automations', ws: m[1]!, tableId: m[2]! };
  if ((m = /^\/w\/([^/]+)\/t\/([^/]+)(?:\/([^/]+))?$/.exec(p))) return { name: 'table', ws: m[1]!, tableId: m[2]!, viewId: m[3] };
  if ((m = /^\/w\/([^/]+)\/settings\/([^/]+)$/.exec(p))) return { name: 'settings', ws: m[1]!, section: m[2]! };
  return { name: 'notfound' };
}
export const tableUrl = (ws: string, tableId: string, viewId?: string) => `/w/${ws}/t/${tableId}${viewId ? '/' + viewId : ''}`;
