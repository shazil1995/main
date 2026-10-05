import { ROLES, permissionsForRole, roleRank, type Permission, type Role } from '@basecraft/shared';

/** Same rule as the server: owners can grant anything, others only roles strictly below their own. */
export function canGrant(actor: Role, target: Role): boolean {
  return actor === 'owner' || roleRank(target) < roleRank(actor);
}
/** Roles an actor may put on a member (owner is only available to owners). */
export const assignableRoles = (actor: Role): Role[] => ROLES.filter((r) => canGrant(actor, r));
/** Roles an actor may invite at: never owner. */
export const invitableRoles = (actor: Role): Role[] => assignableRoles(actor).filter((r) => r !== 'owner');
/** Can this actor change/remove a member who currently has `target`? */
export const canManageMember = (actor: Role, target: Role): boolean => actor === 'owner' || roleRank(target) < roleRank(actor);
export const isAdminRole = (r: Role) => r === 'admin' || r === 'owner';

export const CAPABILITIES: { label: string; all: Permission[] }[] = [
  { label: 'View data', all: ['records:read'] },
  { label: 'Comment', all: ['comments:write'] },
  { label: 'Edit records', all: ['records:write', 'records:delete'] },
  { label: 'Import and export', all: ['records:import', 'records:export'] },
  { label: 'Edit shared views', all: ['views:write_shared'] },
  { label: 'Edit schema (tables and fields)', all: ['schema:write'] },
  { label: 'Manage automations', all: ['automations:write'] },
  { label: 'Manage members', all: ['members:manage'] },
  { label: 'Manage API tokens', all: ['tokens:manage'] },
  { label: 'Read audit log', all: ['audit:read'] },
];

export function capabilityMatrix(): { label: string; roles: Record<Role, boolean> }[] {
  return CAPABILITIES.map((c) => ({
    label: c.label,
    roles: Object.fromEntries(ROLES.map((r) => { const p = permissionsForRole(r); return [r, c.all.every((x) => p.has(x))]; })) as Record<Role, boolean>,
  }));
}

export const inviteLink = (origin: string, token: string) => `${origin}/invite?token=${encodeURIComponent(token)}`;

export interface InvitationLike { expires_at: string; revoked_at: string | null; accepted_at: string | null }
export type InviteStatus = 'accepted' | 'revoked' | 'expired' | 'pending';
export function inviteStatus(i: InvitationLike, now = Date.now()): InviteStatus {
  if (i.accepted_at) return 'accepted';
  if (i.revoked_at) return 'revoked';
  return new Date(i.expires_at).getTime() <= now ? 'expired' : 'pending';
}

export const TOKEN_SCOPE_LABELS: Record<string, string> = {
  'records:read': 'Read records', 'records:write': 'Create and edit records', 'records:delete': 'Delete records',
  'schema:read': 'Read table structure', 'views:read': 'Read views', 'attachments:read': 'Download attachments', 'attachments:write': 'Upload attachments',
};

export interface TokenLike { revoked_at: string | null; expires_at: string | null }
export function tokenStatus(t: TokenLike, now = Date.now()): 'revoked' | 'expired' | 'active' {
  if (t.revoked_at) return 'revoked';
  return t.expires_at && new Date(t.expires_at).getTime() <= now ? 'expired' : 'active';
}

/** Parse a "days" input: blank => null (no expiry); otherwise an integer within [min,max] or undefined (invalid). */
export function parseDays(s: string, min: number, max: number): number | null | undefined {
  const t = s.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= min && n <= max ? n : undefined;
}

export function metaSummary(meta: unknown, max = 160): string {
  if (meta === null || meta === undefined) return '';
  let s: string;
  try { s = JSON.stringify(meta); } catch { s = String(meta); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
