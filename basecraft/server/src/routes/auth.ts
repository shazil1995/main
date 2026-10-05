import { z } from 'zod';
import { audit } from '../audit.js';
import {
  clearSessionCookies, createSession, hashPassword, revokeAllSessions, revokeSession, setSessionCookies,
  throttleCheck, throttleFail, throttleReset, validatePasswordStrength, verifyPassword,
} from '../auth.js';
import { sha256 } from '../crypto.js';
import { withTx } from '../db.js';
import { HttpError, conflict, forbidden, unprocessable } from '../errors.js';
import { created, noContent } from '../http.js';
import { name200, type Reg } from './common.js';
import type { AppContext } from '../http.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(200);

export async function listWorkspaces(app: AppContext, userId: string) {
  const r = await app.db.app.query(
    `SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.user_id = $1 ORDER BY w.created_at`, [userId]);
  return r.rows;
}

export function authRoutes(reg: Reg, app: AppContext) {
  const session = async (ctx: { req: any; reply: any }, user: { id: string; email: string; name: string }) => {
    const s = await createSession(app.db, user.id, ctx.req);
    setSessionCookies(app.config, ctx.reply, s);
    return { user: { id: user.id, email: user.email, name: user.name }, workspaces: await listWorkspaces(app, user.id), csrf_token: s.csrf };
  };

  reg({
    method: 'POST', path: '/auth/signup', tag: 'Auth', auth: 'public', summary: 'Create an account (and a first workspace)',
    body: z.object({ email, name: name200, password, workspace_name: name200.optional(), invite_token: z.string().max(200).optional() }).strict(),
    responses: { 201: 'Account created; session cookies set' },
    async handler(ctx) {
      const b = ctx.body;
      throttleCheck(app.config, `signup:${ctx.req.ip}`);
      const weak = validatePasswordStrength(b.password);
      if (weak) throw unprocessable(weak, [{ field: 'password', message: weak }]);
      let invite: { id: string; workspace_id: string; role: string; email: string } | undefined;
      if (b.invite_token) {
        const r = await app.db.app.query(
          `SELECT id, workspace_id, role, email FROM invitations WHERE token_hash = $1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now()`, [sha256(b.invite_token)]);
        invite = r.rows[0];
        if (!invite || invite.email.toLowerCase() !== b.email) throw forbidden('Invitation is invalid, expired, or for a different email address');
      } else if (!app.config.ALLOW_SIGNUP) throw new HttpError(403, 'signup_disabled', 'Self-service sign-up is disabled. Ask a workspace admin for an invitation.');
      throttleFail(`signup:${ctx.req.ip}`);
      const pwHash = await hashPassword(b.password);
      let user: { id: string; email: string; name: string };
      try {
        user = await withTx(app.db, async (c) => {
          const u = (await c.query(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id, email, name`, [b.email, b.name, pwHash])).rows[0];
          if (invite) {
            await c.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [invite.workspace_id, u.id, invite.role]);
            await c.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [invite.id, u.id]);
          } else {
            const ws = (await c.query(`INSERT INTO workspaces (name, created_by) VALUES ($1,$2) RETURNING id`, [b.workspace_name ?? `${b.name}'s workspace`, u.id])).rows[0];
            await c.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, u.id]);
          }
          return u;
        });
      } catch (e: any) {
        if (e.code === '23505') throw conflict('An account with this email already exists', 'email_taken');
        throw e;
      }
      return created(await session(ctx, user));
    },
  });

  reg({
    method: 'POST', path: '/auth/login', tag: 'Auth', auth: 'public', summary: 'Sign in with email and password',
    body: z.object({ email, password }).strict(),
    responses: { 200: 'Signed in; session cookies set', 401: 'Invalid credentials', 429: 'Throttled' },
    async handler(ctx) {
      const k1 = `login:${ctx.req.ip}:${ctx.body.email}`, k2 = `login:${ctx.body.email}`;
      throttleCheck(app.config, k1); throttleCheck(app.config, k2);
      const u = (await app.db.app.query(`SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1 AND disabled_at IS NULL`, [ctx.body.email])).rows[0];
      const ok = await verifyPassword(u?.password_hash ?? null, ctx.body.password);
      if (!ok || !u) { throttleFail(k1); throttleFail(k2); throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password'); }
      throttleReset(k1);
      ctx.req.log.info({ userId: u.id }, 'login');
      return session(ctx, u);
    },
  });

  reg({
    method: 'POST', path: '/auth/logout', tag: 'Auth', auth: 'session', summary: 'Sign out and revoke the current session',
    async handler(ctx) {
      if (ctx.principal?.type === 'user') await revokeSession(app.db, ctx.principal.sessionId);
      clearSessionCookies(ctx.reply);
      return noContent();
    },
  });

  reg({
    method: 'GET', path: '/auth/me', tag: 'Auth', auth: 'session', summary: 'Current user, workspaces, and CSRF token',
    async handler(ctx) {
      const p = ctx.principal!;
      if (p.type !== 'user') throw forbidden();
      return { user: { id: p.userId, email: p.email, name: p.name }, workspaces: await listWorkspaces(app, p.userId), csrf_token: p.csrf };
    },
  });

  reg({
    method: 'POST', path: '/auth/change-password', tag: 'Auth', auth: 'session', summary: 'Change password and revoke all other sessions',
    body: z.object({ current_password: password, new_password: password }).strict(),
    async handler(ctx) {
      const p = ctx.principal!;
      if (p.type !== 'user') throw forbidden();
      const weak = validatePasswordStrength(ctx.body.new_password);
      if (weak) throw unprocessable(weak, [{ field: 'new_password', message: weak }]);
      const u = (await app.db.app.query(`SELECT password_hash FROM users WHERE id = $1`, [p.userId])).rows[0];
      if (!(await verifyPassword(u.password_hash, ctx.body.current_password))) throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
      const h = await hashPassword(ctx.body.new_password);
      await withTx(app.db, async (c) => {
        await c.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [p.userId, h]);
        await revokeAllSessions(c, p.userId);
      });
      const s = await createSession(app.db, p.userId, ctx.req);
      setSessionCookies(app.config, ctx.reply, s);
      return { ok: true, csrf_token: s.csrf };
    },
  });
  void audit;
}
