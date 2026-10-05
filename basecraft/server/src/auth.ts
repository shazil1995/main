import '@fastify/cookie';
import { hash, verify } from '@node-rs/argon2';
import { TOKEN_ALLOWED_SCOPES, type Permission } from '@basecraft/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { withTx, type Client, type Db } from './db.js';
import { HttpError } from './errors.js';
import type { Principal } from './types.js';

export const SESSION_COOKIE = 'bc_session';
export const CSRF_COOKIE = 'bc_csrf';
export const TOKEN_PREFIX = 'bc_';

// argon2id with the library defaults (19 MiB, t=2, p=1 — OWASP minimum profile).
export const hashPassword = (pw: string) => hash(pw, { algorithm: 2 });
// Pre-computed so unknown-email logins spend the same time as wrong-password logins.
let dummyHash: Promise<string> | undefined;
export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return verify(stored, pw).catch(() => false);
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password is too long';
  if (/^(.)\1+$/.test(pw)) return 'Password is too repetitive';
  return null;
}

// ───────── sessions ─────────
export async function createSession(db: Db, userId: string, req: FastifyRequest): Promise<{ token: string; csrf: string; expires: Date }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + db.config.SESSION_TTL_HOURS * 3600_000);
  await db.app.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(token), csrf, expires, (req.headers['user-agent'] ?? '').slice(0, 300), req.ip],
  );
  return { token, csrf, expires };
}

export function setSessionCookies(config: Config, reply: FastifyReply, s: { token: string; csrf: string; expires: Date }) {
  const secure = config.PUBLIC_ORIGIN.startsWith('https://');
  reply.setCookie(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: s.expires });
  // readable by the SPA so it can echo the value in x-csrf-token (double-submit)
  reply.setCookie(CSRF_COOKIE, s.csrf, { httpOnly: false, sameSite: 'lax', secure, path: '/', expires: s.expires });
}
export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.app.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
}
export async function revokeAllSessions(c: Client, userId: string) {
  await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

// ───────── authentication ─────────
export async function authenticate(db: Db, req: FastifyRequest): Promise<Principal | null> {
  const authz = req.headers.authorization;
  if (authz) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    if (!m || !m[1]!.startsWith(TOKEN_PREFIX)) throw new HttpError(401, 'invalid_token', 'Malformed bearer token');
    return authenticateToken(db, m[1]!);
  }
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const r = await db.app.query(
    `UPDATE sessions s SET last_seen_at = CASE WHEN s.last_seen_at < now() - interval '1 minute' THEN now() ELSE s.last_seen_at END
       FROM users u
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.id = s.user_id AND u.disabled_at IS NULL
      RETURNING s.id, s.user_id, s.csrf_token, u.email, u.name`,
    [sha256(raw)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { type: 'user', userId: row.user_id, sessionId: row.id, csrf: row.csrf_token, email: row.email, name: row.name };
}

async function authenticateToken(db: Db, raw: string): Promise<Principal> {
  const r = await db.app.query(
    `UPDATE api_tokens t SET last_used_at = CASE WHEN t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute' THEN now() ELSE t.last_used_at END
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
      RETURNING t.id, t.workspace_id, t.created_by, t.scopes, t.base_ids, t.table_ids`,
    [sha256(raw)],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(401, 'invalid_token', 'Token is invalid, expired, or revoked');
  const allowed = new Set<string>(TOKEN_ALLOWED_SCOPES);
  return {
    type: 'token', tokenId: row.id, workspaceId: row.workspace_id, createdBy: row.created_by,
    scopes: new Set((row.scopes as string[]).filter((s) => allowed.has(s)) as Permission[]),
    baseIds: row.base_ids, tableIds: row.table_ids,
  };
}

export function newApiToken(): { token: string; prefix: string; hash: Buffer } {
  const token = TOKEN_PREFIX + randomToken(32); // 256 bits of entropy => fast SHA-256 is appropriate
  return { token, prefix: token.slice(0, 11), hash: sha256(token) };
}

// ───────── brute-force throttle (in-memory, bounded; single-process — see SECURITY.md) ─────────
const fails = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
export function throttleCheck(config: Config, key: string): void {
  const e = fails.get(key);
  if (e && Date.now() - e.first > WINDOW_MS) fails.delete(key);
  const cur = fails.get(key);
  if (cur && cur.n >= config.LOGIN_MAX_FAILURES) {
    const retry = Math.ceil((cur.first + WINDOW_MS - Date.now()) / 1000);
    throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again later.', undefined, { 'retry-after': String(Math.max(1, retry)) });
  }
}
export function throttleFail(key: string): void {
  if (fails.size > 10_000) fails.clear();
  const e = fails.get(key);
  if (!e || Date.now() - e.first > WINDOW_MS) fails.set(key, { n: 1, first: Date.now() });
  else e.n++;
}
export function throttleReset(key: string): void { fails.delete(key); }
export const _throttleClearForTests = () => fails.clear();

export { withTx };
