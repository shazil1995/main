import type { FieldType, Role, ViewType, ViewVisibility } from '@basecraft/shared';

export interface SelectOpt { id: string; name: string; color?: string }
export interface Field {
  id: string; name: string; type: FieldType; options: Record<string, any>; position: number; is_primary: boolean; indexed: boolean;
}
export interface TableSummary { id: string; base_id: string; name: string; position: number }
export interface TableDetail extends TableSummary { fields: Field[]; role: Role }
export interface Base { id: string; name: string }
export interface WorkspaceRef { id: string; name: string; role: Role }
export interface Me { user: { id: string; email: string; name: string }; workspaces: WorkspaceRef[]; csrf_token: string }

export interface ApiRecord {
  id: string; version: number; fields: Record<string, any>; created_time: string; modified_time: string; created_by: string | null; updated_by: string | null;
}

export type FilterNode =
  | { field: string; op: string; value?: unknown }
  | { and: FilterNode[] }
  | { or: FilterNode[] };
export interface SortSpec { field: string; direction: 'asc' | 'desc' }

export interface ViewConfig {
  search?: string; filter?: FilterNode; sort?: SortSpec[];
  hiddenFields?: string[]; fieldOrder?: string[]; fieldWidths?: Record<string, number>; groupBy?: string; rowHeight?: 'short' | 'medium' | 'tall';
  kanban?: { groupField: string; cardFields?: string[]; hideEmptyColumn?: boolean };
  gallery?: { coverField?: string; titleField?: string; cardFields?: string[] };
  calendar?: { dateField: string; endDateField?: string; titleField?: string };
  form?: { title?: string; description?: string; submitLabel?: string; successMessage?: string; fields: { field: string; required?: boolean; label?: string; help?: string }[] };
}
export interface View {
  id: string; name: string; type: ViewType; visibility: ViewVisibility; owner_id: string; config: ViewConfig; position: number; version: number;
}

/** The part of a view that defines WHICH records are loaded (shared by every view type). */
export interface RecordQuery { search?: string; filter?: FilterNode; sort?: SortSpec[] }

export interface RecordsPage { records: ApiRecord[]; next_cursor: string | null; prev_cursor: string | null; total?: number; total_capped?: boolean }

/** Props every view renderer receives. Views never fetch with their own HTTP code: they use hooks from lib/queries.ts. */
export interface ViewProps {
  table: TableDetail;
  fields: Field[];
  view: View;
  /** Effective (possibly locally modified, unsaved) configuration. */
  config: ViewConfig;
  query: RecordQuery;
  canEdit: boolean;
  onOpenRecord(id: string): void;
  onConfigChange(patch: Partial<ViewConfig>): void;
}
