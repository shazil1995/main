import { z } from 'zod';
import { FilterSchema, SortSchema } from './query.js';
import { unprocessable } from './errors.js';
import type { FieldRow } from './fieldTypes.js';

const fid = z.string().uuid();
export const ViewConfigSchema = z.object({
  search: z.string().max(200).optional(),
  filter: FilterSchema.optional(),
  sort: SortSchema.optional(),
  hiddenFields: z.array(fid).max(200).optional(),
  fieldOrder: z.array(fid).max(200).optional(),
  fieldWidths: z.record(fid, z.number().int().min(40).max(1200)).optional(),
  groupBy: fid.optional(),
  rowHeight: z.enum(['short', 'medium', 'tall']).optional(),
  kanban: z.object({ groupField: fid, cardFields: z.array(fid).max(20).optional(), hideEmptyColumn: z.boolean().optional() }).strict().optional(),
  gallery: z.object({ coverField: fid.optional(), titleField: fid.optional(), cardFields: z.array(fid).max(20).optional() }).strict().optional(),
  calendar: z.object({ dateField: fid, endDateField: fid.optional(), titleField: fid.optional() }).strict().optional(),
  form: z.object({
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    submitLabel: z.string().max(60).optional(),
    successMessage: z.string().max(500).optional(),
    fields: z.array(z.object({ field: fid, required: z.boolean().optional(), label: z.string().max(200).optional(), help: z.string().max(500).optional() }).strict()).max(200),
  }).strict().optional(),
}).strict();
export type ViewConfig = z.infer<typeof ViewConfigSchema>;

/** Cross-check that every referenced field exists in the table and has a compatible type for the view kind. */
export function validateViewConfig(type: string, cfg: ViewConfig, fields: FieldRow[]) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const errs: { field: string; message: string }[] = [];
  const need = (path: string, id: string | undefined, ok?: (f: FieldRow) => boolean, why = '') => {
    if (!id) return;
    const f = byId.get(id);
    if (!f) errs.push({ field: path, message: 'Unknown field' });
    else if (ok && !ok(f)) errs.push({ field: path, message: why });
  };
  for (const id of cfg.hiddenFields ?? []) need('hiddenFields', id);
  for (const id of cfg.fieldOrder ?? []) need('fieldOrder', id);
  for (const id of Object.keys(cfg.fieldWidths ?? {})) need('fieldWidths', id);
  need('groupBy', cfg.groupBy, (f) => f.type !== 'attachment' && f.type !== 'multi_select', 'Cannot group by this field type');
  if (type === 'kanban') {
    if (!cfg.kanban) errs.push({ field: 'kanban', message: 'Kanban views need kanban.groupField' });
    need('kanban.groupField', cfg.kanban?.groupField, (f) => f.type === 'single_select', 'Kanban columns come from a single select field');
    (cfg.kanban?.cardFields ?? []).forEach((id) => need('kanban.cardFields', id));
  }
  if (type === 'calendar') {
    if (!cfg.calendar) errs.push({ field: 'calendar', message: 'Calendar views need calendar.dateField' });
    const dateOk = (f: FieldRow) => ['date', 'datetime', 'created_time', 'modified_time'].includes(f.type);
    need('calendar.dateField', cfg.calendar?.dateField, dateOk, 'Must be a date or date-time field');
    need('calendar.endDateField', cfg.calendar?.endDateField, dateOk, 'Must be a date or date-time field');
  }
  if (type === 'gallery') {
    need('gallery.coverField', cfg.gallery?.coverField, (f) => f.type === 'attachment', 'Cover must be an attachment field');
    need('gallery.titleField', cfg.gallery?.titleField);
  }
  if (type === 'form') {
    if (!cfg.form?.fields.length) errs.push({ field: 'form.fields', message: 'A form needs at least one field' });
    for (const ff of cfg.form?.fields ?? []) need('form.fields', ff.field, (f) => !['created_time', 'modified_time', 'attachment'].includes(f.type), 'This field type cannot be filled in a form');
  }
  if (errs.length) throw unprocessable('Invalid view configuration', errs);
}
