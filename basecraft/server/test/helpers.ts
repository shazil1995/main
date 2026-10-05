import { loadConfig, type Config } from '../src/config.js';
import { buildApp, type BuiltApp } from '../src/app.js';
import { Worker } from '../src/worker.js';
import { _throttleClearForTests } from '../src/auth.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNER_URL = process.env.TEST_DATABASE_URL ?? 'postgres://basecraft_owner:dev_owner_pw@localhost:5432/basecraft_test';
export const APP_URL = OWNER_URL.replace('basecraft_owner:dev_owner_pw', 'basecraft_app:dev_app_pw');

export function testConfig(over: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'bc-test-'));
  return loadConfig({
    NODE_ENV: 'test', DATABASE_URL: OWNER_URL, APP_DATABASE_URL: APP_URL, SERVER_SECRET: 'x'.repeat(48), PUBLIC_ORIGIN: 'http://localhost:5173',
    WORKER_MODE: 'off', LOG_LEVEL: 'silent', LOGIN_MAX_FAILURES: '1000', RATE_LIMIT_TOKEN_PER_MIN: '100000', RATE_LIMIT_WORKSPACE_PER_MIN: '100000', RATE_LIMIT_ANON_PER_MIN: '100000',
    ATTACHMENT_DIR: join(dir, 'att'), IMPORT_DIR: join(dir, 'imp'), ...over,
  } as NodeJS.ProcessEnv);
}

export interface Res<T = any> { status: number; body: T; headers: Record<string, any>; raw: string }

export class Session {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(public app: BuiltApp, public email = '', public userId = '') {}

  async call<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrf && !('x-csrf-token' in h) && method !== 'GET') h['x-csrf-token'] = this.csrf;
    let payload: any = undefined;
    if (body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
      else { payload = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
    }
    const r = await this.app.fastify.inject({ method: method as any, url, headers: h, payload });
    for (const c of (r.cookies ?? [])) { if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name); else this.cookies.set(c.name, c.value); }
    let parsed: any = r.body;
    try { parsed = r.body ? JSON.parse(r.body) : null; } catch { /* non-json */ }
    return { status: r.statusCode, body: parsed, headers: r.headers, raw: r.body };
  }
  get = <T = any>(u: string, h?: Record<string, string>) => this.call<T>('GET', u, undefined, h);
  post = <T = any>(u: string, b?: unknown, h?: Record<string, string>) => this.call<T>('POST', u, b ?? {}, h);
  patch = <T = any>(u: string, b?: unknown, h?: Record<string, string>) => this.call<T>('PATCH', u, b, h);
  put = <T = any>(u: string, b?: unknown, h?: Record<string, string>) => this.call<T>('PUT', u, b, h);
  del = <T = any>(u: string, h?: Record<string, string>) => this.call<T>('DELETE', u, undefined, h);

  /** multipart upload helper */
  async upload(url: string, parts: { name: string; value?: string; filename?: string; content?: Buffer | string; type?: string }[]): Promise<Res> {
    const boundary = '----bc' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const p of parts) {
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"` + (p.filename !== undefined ? `; filename="${p.filename}"` : '') + '\r\n';
      if (p.filename !== undefined) head += `Content-Type: ${p.type ?? 'application/octet-stream'}\r\n`;
      chunks.push(Buffer.from(head + '\r\n'), p.filename !== undefined ? Buffer.from(p.content ?? '') : Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return this.call('POST', url, Buffer.concat(chunks), { 'content-type': `multipart/form-data; boundary=${boundary}` });
  }
}

let counter = 0;
export async function newApp(over: Record<string, string> = {}): Promise<BuiltApp> {
  const built = await buildApp(testConfig(over));
  _throttleClearForTests();
  await built.fastify.ready();
  return built;
}

export async function signup(app: BuiltApp, name = 'User', wsName?: string): Promise<Session> {
  const email = `u${Date.now()}_${++counter}_${Math.random().toString(16).slice(2, 6)}@example.test`;
  const s = new Session(app, email);
  const r = await s.post('/api/v1/auth/signup', { email, name, password: 'correct horse battery', workspace_name: wsName ?? `${name} WS` });
  if (r.status !== 201) throw new Error('signup failed ' + r.raw);
  s.csrf = r.body.csrf_token; s.userId = r.body.user.id;
  (s as any).workspaceId = r.body.workspaces[0].id;
  return s;
}
export const wsOf = (s: Session): string => (s as any).workspaceId;

export class Token {
  constructor(public app: BuiltApp, public value: string) {}
  async call<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const r = await this.app.fastify.inject({ method: method as any, url, headers: { authorization: `Bearer ${this.value}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, payload: body !== undefined ? JSON.stringify(body) : undefined });
    let parsed: any = r.body; try { parsed = r.body ? JSON.parse(r.body) : null; } catch { /* */ }
    return { status: r.statusCode, body: parsed, headers: r.headers, raw: r.body };
  }
}

export interface Fixture { s: Session; ws: string; base: string; table: string; f: Record<string, string>; fields: any[] }

/** A base + table with one field of every writable type. Field ids are returned keyed by a short name. */
export async function tableFixture(s: Session, tableName = 'Projects'): Promise<Fixture> {
  const ws = wsOf(s);
  const base = (await s.post(`/api/v1/workspaces/${ws}/bases`, { name: 'Signage' })).body.id;
  const t = await s.post(`/api/v1/bases/${base}/tables`, {
    name: tableName,
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'long_text' },
      { name: 'Qty', type: 'integer' },
      { name: 'Margin', type: 'decimal', options: { scale: 2 } },
      { name: 'Price', type: 'currency', options: { currency: 'USD' } },
      { name: 'Discount', type: 'percent', options: { scale: 1, min: '0', max: '100' } },
      { name: 'Due', type: 'date' },
      { name: 'Installed', type: 'datetime', options: { timezone: 'America/New_York' } },
      { name: 'Done', type: 'checkbox' },
      { name: 'Status', type: 'single_select', options: { options: ['Quote', 'Approved', 'Installed'] } },
      { name: 'Tags', type: 'multi_select', options: { options: ['LED', 'Neon', 'Vinyl', 'Outdoor'] } },
      { name: 'Contact', type: 'email' },
      { name: 'Site', type: 'url' },
      { name: 'Phone', type: 'phone' },
      { name: 'Created', type: 'created_time' },
      { name: 'Modified', type: 'modified_time' },
      { name: 'Files', type: 'attachment' },
    ],
  });
  if (t.status !== 201) throw new Error('table create failed ' + t.raw);
  const f: Record<string, string> = {};
  for (const fld of t.body.fields) f[fld.name.toLowerCase()] = fld.id;
  return { s, ws, base, table: t.body.id, f, fields: t.body.fields };
}
export { Worker };
