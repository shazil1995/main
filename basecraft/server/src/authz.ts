import { ROLES, permissionsForRole, roleRank, type GrantRole, type Permission, type Role } from '@basecraft/shared';
import type { Client } from './db.js';
import { forbidden, notFound } from './errors.js';
import type { Access, Principal } from './types.js';

/** Permissions decided by workspace membership only, never by base/table grants. */
const WORKSPACE_LEVEL = new Set<Permission>(['workspace:manage', 'members:manage', 'tokens:manage', 'audit:read']);

interface Scope { workspaceId: string; baseId?: string | null; tableId?: string | null }

/**
 * Resolve what `principal` may do in `scope`. Must run inside the workspace transaction (resource_grants is RLS-protected).
 * Returns null when the principal has no visibility at all (caller answers 404, never 403, so ids cannot be probed).
 */
export async function resolveAccess(c: Client, principal: Principal, scope: Scope): Promise<Access | null> {
  const userId = principal.type === 'user' ? principal.userId : principal.createdBy;
  if (principal.type === 'token') {
    if (principal.workspaceId !== scope.workspaceId) return null;
    if (scope.baseId && principal.baseIds && !principal.baseIds.includes(scope.baseId)) return null;
    if (scope.tableId && principal.tableIds && !principal.tableIds.includes(scope.tableId)) return null;
    if (!scope.baseId && !scope.tableId && (principal.baseIds || principal.tableIds)) {
      // workspace-level routes are visible to restricted tokens only for listing allowed resources; handlers filter.
    }
  }
  const r = await c.query(
    `SELECT m.role,
       (SELECT g.role FROM resource_grants g WHERE g.user_id = m.user_id AND g.resource_type = 'table' AND g.resource_id = $3::uuid) AS table_role,
       (SELECT g.role FROM resource_grants g WHERE g.user_id = m.user_id AND g.resource_type = 'base' AND g.resource_id = $4::uuid) AS base_role
       FROM members m
       JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [scope.workspaceId, userId, scope.tableId ?? null, scope.baseId ?? null],
  );
  const row = r.rows[0];
  if (!row) return null;
  const workspaceRole = row.role as Role;
  const granted = (row.table_role ?? row.base_role ?? null) as GrantRole | null;
  if (granted === 'none') return null;
  const role: Role = (granted as Role | null) ?? workspaceRole;
  const rolePerms = permissionsForRole(role);
  const wsPerms = permissionsForRole(workspaceRole);

  const base = (p: Permission) => (WORKSPACE_LEVEL.has(p) ? wsPerms.has(p) : rolePerms.has(p));
  const has = principal.type === 'user'
    ? base
    : (p: Permission) => !WORKSPACE_LEVEL.has(p) && principal.scopes.has(p) && base(p);
  return { workspaceId: scope.workspaceId, baseId: scope.baseId ?? null, tableId: scope.tableId ?? null, workspaceRole, role, has };
}

export function requirePermission(access: Access, p: Permission): void {
  if (!access.has(p)) throw forbidden(`Missing permission: ${p}`);
}

/** Highest role ordering helper for invitation/role-change checks: you can only grant roles below your own. */
export function canGrantRole(actorRole: Role, target: Role): boolean {
  if (actorRole === 'owner') return true;
  return roleRank(target) < roleRank(actorRole);
}

/** Filter resource ids (tables/bases) the principal may see, applying grants and token allow-lists. */
export async function hiddenResourceIds(c: Client, principal: Principal, workspaceId: string): Promise<{ none: Set<string>; allow: Set<string> | null }> {
  const userId = principal.type === 'user' ? principal.userId : principal.createdBy;
  const r = await c.query(`SELECT resource_id FROM resource_grants WHERE workspace_id = $1 AND user_id = $2 AND role = 'none'`, [workspaceId, userId]);
  return { none: new Set(r.rows.map((x) => x.resource_id as string)), allow: null };
}
export { ROLES, notFound };
