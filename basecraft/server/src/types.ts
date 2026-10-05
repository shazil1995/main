import type { Permission, Role } from '@basecraft/shared';

export type Principal =
  | { type: 'user'; userId: string; sessionId: string; csrf: string; email: string; name: string }
  | {
      type: 'token'; tokenId: string; workspaceId: string; createdBy: string;
      scopes: ReadonlySet<Permission>; baseIds: string[] | null; tableIds: string[] | null;
    };

export interface Access {
  workspaceId: string;
  baseId: string | null;
  tableId: string | null;
  /** Role in the workspace (membership). */
  workspaceRole: Role;
  /** Role on the specific base/table after resource grants (never 'none': hidden resources 404 before this). */
  role: Role;
  /** Effective permissions on this scope (for tokens: scopes ∩ creator's permissions; workspace-level perms excluded). */
  has(p: Permission): boolean;
}

export const principalId = (p: Principal) => (p.type === 'user' ? p.userId : p.tokenId);
export const actorOf = (p: Principal | null) =>
  p ? ({ type: p.type, id: principalId(p) } as const) : ({ type: 'system', id: null } as const);
export type Actor = ReturnType<typeof actorOf>;
