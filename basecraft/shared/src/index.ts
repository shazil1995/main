// Pure, dependency-free definitions shared by API and web. The server is always authoritative.

export const FIELD_TYPES = [
  'text', 'long_text', 'integer', 'decimal', 'currency', 'percent', 'date', 'datetime',
  'checkbox', 'single_select', 'multi_select', 'email', 'url', 'phone',
  'created_time', 'modified_time', 'attachment',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose value is derived from record metadata or another table; never writable. */
export const READONLY_FIELD_TYPES: readonly FieldType[] = ['created_time', 'modified_time', 'attachment'];

export type SqlKind = 'text' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'array' | 'none';

export const FIELD_SQL_KIND: Record<FieldType, SqlKind> = {
  text: 'text', long_text: 'text', integer: 'numeric', decimal: 'numeric', currency: 'numeric',
  percent: 'numeric', date: 'date', datetime: 'timestamptz', checkbox: 'boolean',
  single_select: 'text', multi_select: 'array', email: 'text', url: 'text', phone: 'text',
  created_time: 'timestamptz', modified_time: 'timestamptz', attachment: 'none',
};

export const FILTER_OPERATORS = [
  'is_empty', 'is_not_empty', 'eq', 'neq', 'contains', 'not_contains', 'starts_with',
  'gt', 'gte', 'lt', 'lte', 'is_true', 'is_false', 'has_any', 'has_all', 'has_none',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const T_TEXT: FilterOperator[] = ['is_empty', 'is_not_empty', 'eq', 'neq', 'contains', 'not_contains', 'starts_with'];
const T_NUM: FilterOperator[] = ['is_empty', 'is_not_empty', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
export const OPERATORS_BY_KIND: Record<SqlKind, FilterOperator[]> = {
  text: T_TEXT,
  numeric: T_NUM,
  boolean: ['is_true', 'is_false', 'is_empty', 'is_not_empty'],
  date: T_NUM,
  timestamptz: T_NUM,
  array: ['is_empty', 'is_not_empty', 'has_any', 'has_all', 'has_none'],
  none: ['is_empty', 'is_not_empty'],
};
/** single_select supports exact-match operators instead of substring operators. */
export const OPERATORS_SINGLE_SELECT: FilterOperator[] = ['is_empty', 'is_not_empty', 'eq', 'neq', 'has_any', 'has_none'];

export const VIEW_TYPES = ['grid', 'kanban', 'gallery', 'calendar', 'form'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export const VIEW_VISIBILITY = ['personal', 'shared', 'locked'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITY)[number];

export const ROLES = ['viewer', 'commenter', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
/** Resource-level grants may additionally hide a base/table entirely. */
export type GrantRole = Role | 'none';

export const PERMISSIONS = [
  'workspace:manage', 'members:manage', 'tokens:manage', 'audit:read',
  'schema:read', 'schema:write',
  'records:read', 'records:write', 'records:delete', 'records:import', 'records:export',
  'comments:read', 'comments:write',
  'views:read', 'views:write_personal', 'views:write_shared', 'views:manage_locked',
  'attachments:read', 'attachments:write',
  'automations:read', 'automations:write',
  'forms:submit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Documented permission matrix. Each role inherits every permission of the roles below it. */
const BASE: Record<Role, Permission[]> = {
  viewer: ['schema:read', 'records:read', 'comments:read', 'views:read', 'views:write_personal', 'attachments:read'],
  commenter: ['comments:write'],
  editor: [
    'records:write', 'records:delete', 'records:import', 'records:export', 'views:write_shared',
    'attachments:write', 'automations:read', 'forms:submit',
  ],
  admin: [
    'members:manage', 'tokens:manage', 'audit:read', 'schema:write', 'views:manage_locked', 'automations:write',
  ],
  owner: ['workspace:manage'],
};
export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const r of ROLES) {
    BASE[r].forEach((p) => out.add(p));
    if (r === role) break;
  }
  return out;
}
export function roleRank(role: GrantRole): number {
  return role === 'none' ? -1 : ROLES.indexOf(role);
}

/** Permissions an API token may ever carry. Tokens can never administer members, tokens, audit, automations or schema. */
export const TOKEN_ALLOWED_SCOPES = [
  'schema:read', 'records:read', 'records:write', 'records:delete', 'views:read', 'attachments:read', 'attachments:write',
] as const satisfies readonly Permission[];
export type TokenScope = (typeof TOKEN_ALLOWED_SCOPES)[number];

export const AUTOMATION_TRIGGERS = ['record_created', 'record_updated', 'condition_matched', 'form_submitted'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export interface SelectOption { id: string; name: string; color?: string }

export const LIMITS = {
  maxPageSize: 500,
  defaultPageSize: 100,
  maxBatch: 100,
  maxFieldsPerTable: 200,
  maxRecordBytes: 262144,
  maxTextLength: 100_000,
  maxShortTextLength: 2_000,
  maxFilterDepth: 4,
  maxFilterConditions: 50,
  maxSorts: 4,
} as const;

/** Cells starting with these characters can execute as spreadsheet formulas; exports neutralise them. */
export const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;
export function csvSafeCell(s: string): string {
  return s.length > 0 && (CSV_FORMULA_PREFIXES as readonly string[]).includes(s[0]!) ? `'${s}` : s;
}
