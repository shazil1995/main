export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public traceId?: string) { super(message); }
  /** Per-field messages from a 422, keyed by field id. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    const d = Array.isArray(this.details) ? this.details : Array.isArray(this.details?.cause) ? this.details.cause : Array.isArray(this.details?.errors) ? this.details.errors : [];
    for (const e of d) if (e?.field) out[e.field] = e.message;
    return out;
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('bc_csrf='))?.slice('bc_csrf='.length) ?? '';

export interface ReqOpts { headers?: Record<string, string>; signal?: AbortSignal; raw?: boolean }

export async function api<T = any>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (method !== 'GET') headers['x-csrf-token'] = csrf();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const e = json?.error;
    const err = new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details, e?.trace_id);
    if (res.status === 401 && err.code === 'unauthorized') onUnauthorized?.();
    throw err;
  }
  return json as T;
}
export const get = <T = any>(p: string, o?: ReqOpts) => api<T>('GET', p, undefined, o);
export const post = <T = any>(p: string, b?: unknown, o?: ReqOpts) => api<T>('POST', p, b ?? {}, o);
export const patch = <T = any>(p: string, b: unknown, o?: ReqOpts) => api<T>('PATCH', p, b, o);
export const put = <T = any>(p: string, b: unknown, o?: ReqOpts) => api<T>('PUT', p, b, o);
export const del = <T = any>(p: string, o?: ReqOpts) => api<T>('DELETE', p, undefined, o);

/** Download a streamed export without buffering it in JS memory: the browser saves the response body directly. */
export async function downloadExport(tableId: string, body: unknown, filename: string): Promise<void> {
  const res = await api<Response>('POST', `/tables/${tableId}/export`, body, { raw: true });
  if (!res.ok) { const j = await res.json().catch(() => null); throw new ApiError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? 'Export failed', j?.error?.details, j?.error?.trace_id); }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
