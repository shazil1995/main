import { z } from 'zod';
import { ROLES, TOKEN_ALLOWED_SCOPES, roleRank, type Role } from '@basecraft/shared';
import { canGrantRole } from '../authz.js';
import { newApiToken } from '../auth.js';
import { sha256, randomToken } from '../crypto.js';
import { withTx } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { created, noContent, type AppContext } from '../http.js';
import { listWorkspaces } from './auth.js';
import { idParam, name200, uuid, type Reg } from './common.js';

const role = z.enum(ROLES);
const assignable = z.enum(['viewer', 'commenter', 'editor', 'admin']);
const wsParam = idParam('workspaceId');

export function workspaceRoutes(reg: Reg, app: AppContext) {
  reg({
    method: 'GET', path: '/workspaces', tag: 'Workspaces', auth: 'any', summary: 'List workspaces you belong to',
    async handler(ctx) {
      const p = ctx.principal!;
      if (p.type === 'token') {
        const r = await app.db.app.query(`SELECT id, name FROM workspaces WHERE id = $1 AND deleted_at IS NULL`, [p.workspaceId]);
        return { workspaces: r.rows.map((w) => ({ ...w, role: null })) };
      }
      return { workspaces: await listWorkspaces(app, p.userId) };
    },
  });

  reg({
    method: 'POST', path: '/workspaces', tag: 'Workspaces', auth: 'session', summary: 'Create a workspace (you become owner)',
    body: z.object({ name: name200 }).strict(),
    async handler(ctx) {
      const p = ctx.principal!;
      if (p.type !== 'user') throw forbidden();
      const ws = await withTx(app.db, async (c) => {
        const w = (await c.query(`INSERT INTO workspaces (name, created_by) VALUES ($1,$2) RETURNING id, name`, [ctx.body.name, p.userId])).rows[0];
        await c.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [w.id, p.userId]);
        return w;
      });
      return created({ ...ws, role: 'owner' });
    },
  });

  reg({
    method: 'GET', path: '/workspaces/:workspaceId', tag: 'Workspaces', auth: 'any', summary: 'Workspace details and usage',
    params: wsParam, scope: { resource: 'workspace', param: 'workspaceId', permission: 'schema:read' },
    async handler(ctx) {
      const c = ctx.c!;
      const w = (await c.query(`SELECT id, name, attachment_quota_bytes FROM workspaces WHERE id = $1`, [ctx.params.workspaceId])).rows[0];
      const u = (await c.query(`SELECT coalesce(sum(size_bytes),0) AS bytes FROM attachments WHERE deleted_at IS NULL`)).rows[0];
      return { id: w.id, name: w.name, role: ctx.access!.workspaceRole, attachment_bytes_used: Number(u.bytes), attachment_quota_bytes: Number(w.attachment_quota_bytes) };
    },
  });

  reg({
    method: 'PATCH', path: '/workspaces/:workspaceId', tag: 'Workspaces', auth: 'session', summary: 'Rename workspace',
    params: wsParam, body: z.object({ name: name200 }).strict(),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'workspace:manage' },
    async handler(ctx) {
      await app.db.app.query(`UPDATE workspaces SET name = $2 WHERE id = $1`, [ctx.params.workspaceId, ctx.body.name]);
      await ctx.audit('workspace.rename', { type: 'workspace', id: ctx.params.workspaceId }, { name: ctx.body.name });
      return { ok: true };
    },
  });

  // ───────── members ─────────
  reg({
    method: 'GET', path: '/workspaces/:workspaceId/members', tag: 'Members', auth: 'session', summary: 'List members',
    params: wsParam, scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const r = await ctx.c!.query(
        `SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`, [ctx.params.workspaceId]);
      return { members: r.rows };
    },
  });

  reg({
    method: 'PATCH', path: '/workspaces/:workspaceId/members/:userId', tag: 'Members', auth: 'session', summary: 'Change a member role',
    params: z.object({ workspaceId: uuid, userId: uuid }), body: z.object({ role: role }).strict(),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const { workspaceId, userId } = ctx.params;
      const actor = ctx.access!.workspaceRole;
      const target = (await ctx.c!.query(`SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [workspaceId, userId])).rows[0];
      if (!target) throw notFound('Member');
      if (actor !== 'owner' && roleRank(target.role) >= roleRank(actor)) throw forbidden('You cannot change the role of someone at or above your own role');
      if (!canGrantRole(actor, ctx.body.role)) throw forbidden('You can only assign roles below your own');
      if (target.role === 'owner' && ctx.body.role !== 'owner') {
        const owners = (await ctx.c!.query(`SELECT count(*)::int n FROM members WHERE workspace_id=$1 AND role='owner'`, [workspaceId])).rows[0].n;
        if (owners <= 1) throw conflict('A workspace must keep at least one owner', 'last_owner');
      }
      await ctx.c!.query(`UPDATE members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId, ctx.body.role]);
      await ctx.audit('member.role_change', { type: 'user', id: userId }, { from: target.role, to: ctx.body.role });
      return { ok: true };
    },
  });

  reg({
    method: 'DELETE', path: '/workspaces/:workspaceId/members/:userId', tag: 'Members', auth: 'session', summary: 'Remove a member',
    params: z.object({ workspaceId: uuid, userId: uuid }),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const { workspaceId, userId } = ctx.params;
      const actor = ctx.access!.workspaceRole;
      const target = (await ctx.c!.query(`SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [workspaceId, userId])).rows[0];
      if (!target) throw notFound('Member');
      if (actor !== 'owner' && roleRank(target.role) >= roleRank(actor)) throw forbidden('You cannot remove someone at or above your own role');
      if (target.role === 'owner') {
        const owners = (await ctx.c!.query(`SELECT count(*)::int n FROM members WHERE workspace_id=$1 AND role='owner'`, [workspaceId])).rows[0].n;
        if (owners <= 1) throw conflict('A workspace must keep at least one owner', 'last_owner');
      }
      await ctx.c!.query(`DELETE FROM members WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
      await ctx.c!.query(`DELETE FROM resource_grants WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
      // tokens created by this user stop working immediately (authz ties tokens to the creator's membership)
      await ctx.audit('member.remove', { type: 'user', id: userId }, { role: target.role });
      return noContent();
    },
  });

  // ───────── invitations (never emailed automatically; the link is shown once to the admin) ─────────
  reg({
    method: 'POST', path: '/workspaces/:workspaceId/invitations', tag: 'Members', auth: 'session', summary: 'Create an invitation (returns the one-time token; no email is sent)',
    params: wsParam,
    body: z.object({ email: z.string().trim().toLowerCase().email().max(254), role: assignable, expires_in_days: z.number().int().min(1).max(30).default(7) }).strict(),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      if (!canGrantRole(ctx.access!.workspaceRole, ctx.body.role)) throw forbidden('You can only invite at roles below your own');
      const token = 'bci_' + randomToken(32);
      const r = await app.db.app.query(
        `INSERT INTO invitations (workspace_id, email, role, token_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id, expires_at`,
        [ctx.params.workspaceId, ctx.body.email, ctx.body.role, sha256(token), (ctx.principal as any).userId, ctx.body.expires_in_days]);
      await ctx.audit('invitation.create', { type: 'invitation', id: r.rows[0].id }, { email: ctx.body.email, role: ctx.body.role });
      return created({ id: r.rows[0].id, email: ctx.body.email, role: ctx.body.role, expires_at: r.rows[0].expires_at, token, note: 'Shown once. Share it with the invitee yourself; Basecraft does not send email.' });
    },
  });

  reg({
    method: 'GET', path: '/workspaces/:workspaceId/invitations', tag: 'Members', auth: 'session', summary: 'List invitations',
    params: wsParam, scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const r = await app.db.app.query(
        `SELECT id, email, role, created_at, expires_at, revoked_at, accepted_at FROM invitations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200`, [ctx.params.workspaceId]);
      return { invitations: r.rows };
    },
  });

  reg({
    method: 'DELETE', path: '/invitations/:invitationId', tag: 'Members', auth: 'session', summary: 'Revoke an invitation',
    params: idParam('invitationId'), scope: { resource: 'invitation', param: 'invitationId', permission: 'members:manage' },
    async handler(ctx) {
      await app.db.app.query(`UPDATE invitations SET revoked_at = now() WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL`, [ctx.params.invitationId, ctx.access!.workspaceId]);
      await ctx.audit('invitation.revoke', { type: 'invitation', id: ctx.params.invitationId });
      return noContent();
    },
  });

  reg({
    method: 'POST', path: '/invitations/accept', tag: 'Members', auth: 'session', summary: 'Accept an invitation with its token',
    body: z.object({ token: z.string().min(10).max(200) }).strict(),
    async handler(ctx) {
      const p = ctx.principal!;
      if (p.type !== 'user') throw forbidden();
      return withTx(app.db, async (c) => {
        const inv = (await c.query(`SELECT id, workspace_id, email, role FROM invitations WHERE token_hash=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(ctx.body.token)])).rows[0];
        if (!inv || inv.email.toLowerCase() !== p.email.toLowerCase()) throw forbidden('Invitation is invalid, expired, or addressed to a different email');
        const existing = (await c.query(`SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2`, [inv.workspace_id, p.userId])).rows[0];
        if (!existing) await c.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [inv.workspace_id, p.userId, inv.role]);
        else if (roleRank(inv.role) > roleRank(existing.role) && existing.role !== 'owner') await c.query(`UPDATE members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`, [inv.workspace_id, p.userId, inv.role]);
        await c.query(`UPDATE invitations SET accepted_at=now(), accepted_by=$2 WHERE id=$1`, [inv.id, p.userId]);
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [inv.workspace_id]);
        await c.query(`INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1,'user',$2,'invitation.accept','invitation',$3,$4)`,
          [inv.workspace_id, p.userId, inv.id, JSON.stringify({ role: inv.role })]);
        return { workspace_id: inv.workspace_id, role: inv.role };
      });
    },
  });

  // ───────── per-base / per-table grants ─────────
  reg({
    method: 'GET', path: '/workspaces/:workspaceId/grants', tag: 'Members', auth: 'session', summary: 'List base/table role grants',
    params: wsParam, scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const r = await ctx.c!.query(`SELECT user_id, resource_type, resource_id, role FROM resource_grants WHERE workspace_id=$1 ORDER BY created_at`, [ctx.params.workspaceId]);
      return { grants: r.rows };
    },
  });

  reg({
    method: 'PUT', path: '/workspaces/:workspaceId/grants', tag: 'Members', auth: 'session',
    summary: 'Set (or clear with role=null) a role override for one user on a base or table. role "none" hides the resource.',
    params: wsParam,
    body: z.object({ user_id: uuid, resource_type: z.enum(['base', 'table']), resource_id: uuid, role: z.enum(['none', 'viewer', 'commenter', 'editor', 'admin']).nullable() }).strict(),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'members:manage' },
    async handler(ctx) {
      const b = ctx.body, ws = ctx.params.workspaceId, c = ctx.c!;
      const member = (await c.query(`SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2`, [ws, b.user_id])).rows[0];
      if (!member) throw notFound('Member');
      if (member.role === 'owner') throw unprocessable('Owners always have full access; grants do not apply');
      if (b.role && b.role !== 'none' && !canGrantRole(ctx.access!.workspaceRole, b.role as Role)) throw forbidden('You can only grant roles below your own');
      const exists = (await c.query(b.resource_type === 'base' ? `SELECT 1 FROM bases WHERE id=$1 AND deleted_at IS NULL` : `SELECT 1 FROM tables WHERE id=$1 AND deleted_at IS NULL`, [b.resource_id])).rowCount;
      if (!exists) throw notFound(b.resource_type);
      if (b.role === null) await c.query(`DELETE FROM resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3`, [b.user_id, b.resource_type, b.resource_id]);
      else await c.query(
        `INSERT INTO resource_grants (workspace_id, user_id, resource_type, resource_id, role) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, resource_type, resource_id) DO UPDATE SET role = EXCLUDED.role`, [ws, b.user_id, b.resource_type, b.resource_id, b.role]);
      await ctx.audit('grant.set', { type: b.resource_type, id: b.resource_id }, { user_id: b.user_id, role: b.role });
      return { ok: true };
    },
  });

  // ───────── API tokens ─────────
  const tokenBody = z.object({
    name: name200,
    scopes: z.array(z.enum(TOKEN_ALLOWED_SCOPES)).min(1),
    base_ids: z.array(uuid).max(100).nullable().optional(),
    table_ids: z.array(uuid).max(100).nullable().optional(),
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
  }).strict();

  reg({
    method: 'POST', path: '/workspaces/:workspaceId/tokens', tag: 'API tokens', auth: 'session',
    summary: 'Create an API token (value shown once). Tokens can never administer members, tokens, automations, or schema.',
    params: wsParam, body: tokenBody, scope: { resource: 'workspace', param: 'workspaceId', permission: 'tokens:manage' },
    async handler(ctx) {
      const b = ctx.body, c = ctx.c!;
      for (const [col, tbl, ids] of [['base', 'bases', b.base_ids], ['table', 'tables', b.table_ids]] as const) {
        if (ids?.length) {
          const n = (await c.query(`SELECT count(*)::int n FROM ${tbl} WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])).rows[0].n;
          if (n !== new Set(ids).size) throw unprocessable(`Unknown ${col} id in token restriction`);
        }
      }
      const t = newApiToken();
      const r = await c.query(
        `INSERT INTO api_tokens (workspace_id, name, token_prefix, token_hash, scopes, base_ids, table_ids, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(days => $9::int) END)
         RETURNING id, expires_at, created_at`,
        [ctx.params.workspaceId, b.name, t.prefix, t.hash, b.scopes, b.base_ids ?? null, b.table_ids ?? null, (ctx.principal as any).userId, b.expires_in_days ?? null]);
      await ctx.audit('token.create', { type: 'token', id: r.rows[0].id }, { name: b.name, scopes: b.scopes, expires_at: r.rows[0].expires_at });
      return created({ id: r.rows[0].id, name: b.name, token: t.token, prefix: t.prefix, scopes: b.scopes, expires_at: r.rows[0].expires_at, note: 'Store this token now; it cannot be shown again.' });
    },
  });

  reg({
    method: 'GET', path: '/workspaces/:workspaceId/tokens', tag: 'API tokens', auth: 'session', summary: 'List API tokens (never returns token values)',
    params: wsParam, scope: { resource: 'workspace', param: 'workspaceId', permission: 'tokens:manage' },
    async handler(ctx) {
      const r = await ctx.c!.query(
        `SELECT id, name, token_prefix AS prefix, scopes, base_ids, table_ids, created_at, expires_at, revoked_at, last_used_at FROM api_tokens WHERE workspace_id=$1 ORDER BY created_at DESC`, [ctx.params.workspaceId]);
      return { tokens: r.rows };
    },
  });

  reg({
    method: 'DELETE', path: '/tokens/:tokenId', tag: 'API tokens', auth: 'session', summary: 'Revoke a token',
    params: idParam('tokenId'), scope: { resource: 'token', param: 'tokenId', permission: 'tokens:manage' },
    async handler(ctx) {
      await app.db.app.query(`UPDATE api_tokens SET revoked_at = now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`, [ctx.params.tokenId, ctx.access!.workspaceId]);
      await ctx.audit('token.revoke', { type: 'token', id: ctx.params.tokenId });
      return noContent();
    },
  });

  reg({
    method: 'POST', path: '/tokens/:tokenId/rotate', tag: 'API tokens', auth: 'session', summary: 'Rotate: issue a replacement with the same scopes and revoke the old token',
    params: idParam('tokenId'), scope: { resource: 'token', param: 'tokenId', permission: 'tokens:manage' },
    async handler(ctx) {
      const c = ctx.c!;
      const old = (await c.query(`SELECT * FROM api_tokens WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [ctx.params.tokenId, ctx.access!.workspaceId])).rows[0];
      if (!old) throw notFound('Token');
      const t = newApiToken();
      const r = await c.query(
        `INSERT INTO api_tokens (workspace_id, name, token_prefix, token_hash, scopes, base_ids, table_ids, created_by, expires_at, rotated_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [old.workspace_id, old.name, t.prefix, t.hash, old.scopes, old.base_ids, old.table_ids, (ctx.principal as any).userId, old.expires_at, old.id]);
      await c.query(`UPDATE api_tokens SET revoked_at = now() WHERE id=$1`, [old.id]);
      await ctx.audit('token.rotate', { type: 'token', id: r.rows[0].id }, { replaced: old.id });
      return created({ id: r.rows[0].id, token: t.token, prefix: t.prefix, note: 'The previous token is revoked. Store this one now.' });
    },
  });

  // ───────── audit log ─────────
  reg({
    method: 'GET', path: '/workspaces/:workspaceId/audit', tag: 'Audit', auth: 'session', summary: 'Read the append-only audit trail (newest first)',
    params: wsParam, query: z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().max(100).optional() }),
    scope: { resource: 'workspace', param: 'workspaceId', permission: 'audit:read' },
    async handler(ctx) {
      const q = ctx.query;
      const r = await ctx.c!.query(
        `SELECT id, actor_type, actor_id, action, target_type, target_id, metadata, ip, trace_id, created_at FROM audit_events
          WHERE workspace_id=$1 AND ($2::bigint IS NULL OR id < $2) AND ($3::text IS NULL OR action LIKE $3 || '%') ORDER BY id DESC LIMIT $4`,
        [ctx.params.workspaceId, q.before ?? null, q.action ?? null, q.limit]);
      return { events: r.rows, next_before: r.rows.length === q.limit ? r.rows[r.rows.length - 1].id : null };
    },
  });
}
