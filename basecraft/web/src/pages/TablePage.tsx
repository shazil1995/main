import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { del } from '../api';
import { ExportMenu } from '../components/ExportMenu';
import { ImportDialog } from '../components/ImportDialog';
import { cleanFilter, countConditions, FilterBuilder } from '../components/FilterBuilder';
import { RecordPanel } from '../components/RecordPanel';
import { Dialog, ErrorState, Popover, Spinner, errText, useConfirm, useToast } from '../components/ui';
import { AddFieldDialog, FieldsMenu, SortMenu, visibleFields } from '../components/ViewControls';
import { navigate, tableUrl } from '../lib/router';
import { qk, useRecordMutations, useSaveView, useTable, useViews } from '../lib/queries';
import { GridView } from '../views/GridView';
import type { ApiRecord, Me, RecordQuery, View, ViewConfig, WorkspaceRef } from '../types';
import { VIEW_TYPES, type ViewType, type ViewVisibility } from '@basecraft/shared';

const KanbanView = lazy(() => import('../views/KanbanView').then((m) => ({ default: m.KanbanView })));
const GalleryView = lazy(() => import('../views/GalleryView').then((m) => ({ default: m.GalleryView })));
const CalendarView = lazy(() => import('../views/CalendarView').then((m) => ({ default: m.CalendarView })));
const FormView = lazy(() => import('../views/FormView').then((m) => ({ default: m.FormView })));

const ICON: Record<string, string> = { grid: '▦', kanban: '▥', gallery: '▣', calendar: '▤', form: '☰' };
const rank = { viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4 } as const;

export function TablePage({ ws, tableId, viewId, me }: { ws: WorkspaceRef; tableId: string; viewId?: string; me: Me }) {
  const table = useTable(tableId);
  const views = useViews(tableId);
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, node: confirmNode } = useConfirm();
  const save = useSaveView(tableId);
  const { create } = useRecordMutations(tableId);
  const [draft, setDraft] = useState<Partial<ViewConfig>>({});
  const [search, setSearch] = useState('');
  const [openRec, setOpenRec] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'field' | 'import' | 'newview'>(null);
  const [loaded, setLoaded] = useState<{ rows: ApiRecord[]; total?: number; capped: boolean }>({ rows: [], capped: false });

  const view: View | undefined = views.data?.find((v) => v.id === viewId) ?? views.data?.[0];
  useEffect(() => { setDraft({}); setSearch(''); setOpenRec(null); }, [view?.id]);
  useEffect(() => { if (view && !viewId) navigate(tableUrl(ws.id, tableId, view.id), true); }, [view?.id, viewId]); // eslint-disable-line react-hooks/exhaustive-deps
  const config: ViewConfig = useMemo(() => ({ ...(view?.config ?? {}), ...draft }), [view, draft]);
  // debounce the search box into the query (server-side search; superseded requests are cancelled by react-query)
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(t); }, [search]);
  const query: RecordQuery = useMemo(() => ({ search: debounced.trim() || config.search || undefined, filter: cleanFilter(config.filter), sort: config.sort }), [debounced, config.search, config.filter, config.sort]);

  if (table.isLoading || views.isLoading) return <Spinner />;
  if (table.error || !table.data) return <ErrorState error={table.error ?? new Error('Table not found')} retry={() => void table.refetch()} />;
  if (views.error) return <ErrorState error={views.error} retry={() => void views.refetch()} />;
  if (!view) return <div className="empty">This table has no views you can see.</div>;

  const t = table.data, role = rank[t.role];
  const canEdit = role >= rank.editor, canSchema = role >= rank.admin, canComment = role >= rank.commenter;
  const dirty = Object.keys(draft).length > 0;
  const change = (patch: Partial<ViewConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const canSaveThis = view.visibility === 'personal' ? view.owner_id === me.user.id : view.visibility === 'shared' ? role >= rank.editor : role >= rank.admin;
  const vis = visibleFields(t.fields, config);
  const nFilters = countConditions(cleanFilter(config.filter));
  const props = { table: t, fields: t.fields, view, config, query, canEdit, onOpenRecord: setOpenRec, onConfigChange: change };

  const doSave = async () => {
    try { await save.mutateAsync({ id: view.id, name: view.name, type: view.type, visibility: view.visibility, config: { ...view.config, ...draft }, version: view.version }); setDraft({}); toast.push('info', 'View saved'); }
    catch (e) { toast.push('error', errText(e)); }
  };
  const addRecord = async () => { try { const r = await create({}); setOpenRec(r.id); } catch (e) { toast.push('error', errText(e)); } };
  const deleteView = async () => {
    if (!(await confirm(`Delete the view “${view.name}”? Records are not affected.`))) return;
    try { await del(`/views/${view.id}`); await qc.invalidateQueries({ queryKey: qk.views(tableId) }); navigate(tableUrl(ws.id, tableId)); } catch (e) { toast.push('error', errText(e)); }
  };
  const idx = loaded.rows.findIndex((r) => r.id === openRec);

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Views">
        {views.data!.map((v) => (
          <button key={v.id} role="tab" className="tab" aria-selected={v.id === view.id} onClick={() => navigate(tableUrl(ws.id, tableId, v.id))}>
            <span aria-hidden>{ICON[v.type]}</span>{v.name}{v.visibility !== 'shared' && <span className="badge">{v.visibility}</span>}
          </button>
        ))}
        <button className="tab muted" onClick={() => setDialog('newview')}>+ View</button>
      </div>
      <div className="toolbar" role="toolbar" aria-label="View controls">
        <strong style={{ marginRight: 8 }}>{t.name}</strong>
        {view.type !== 'form' && <>
          <label className="sr-only" htmlFor="rec-search">Search records</label>
          <input id="rec-search" type="search" className="input" style={{ width: 200 }} placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Popover label={<>Filter{nFilters > 0 && <span className="badge">{nFilters}</span>}</>}><FilterBuilder fields={t.fields} value={config.filter} onChange={(f) => change({ filter: f })} /></Popover>
          <Popover label={<>Sort{config.sort?.length ? <span className="badge">{config.sort.length}</span> : null}</>}><SortMenu fields={t.fields} value={config.sort ?? []} onChange={(s) => change({ sort: s })} /></Popover>
          {view.type === 'grid' && <Popover label={<>Fields{(config.hiddenFields?.length ?? 0) > 0 && <span className="badge">{config.hiddenFields!.length} hidden</span>}</>}><FieldsMenu fields={t.fields} config={config} onChange={change} onAddField={() => setDialog('field')} canAdd={canSchema} /></Popover>}
        </>}
        <span className="spacer" />
        {dirty && <><span className="badge" role="status">Unsaved view changes</span>
          {canSaveThis && <button className="btn small primary" onClick={doSave} disabled={save.isPending}>Save view</button>}
          <button className="btn small" onClick={() => { setDraft({}); setSearch(''); }}>Revert</button></>}
        {canEdit && <button className="btn small" onClick={() => setDialog('import')}>Import CSV</button>}
        {view.type !== 'form' && <ExportMenu table={t} fields={t.fields} query={query} viewId={view.id} loadedRows={loaded.rows} visibleFieldIds={vis.map((f) => f.id)} canExport={canEdit} />}
        {canSchema && view.type !== 'grid' && view.type !== 'form' && <button className="btn small" onClick={() => setDialog('field')}>+ Field</button>}
        {role >= rank.editor && <a className="btn small" href={`/w/${ws.id}/t/${tableId}/automations`} onClick={(e) => { e.preventDefault(); navigate(`/w/${ws.id}/t/${tableId}/automations`); }}>Automations</a>}
        {canSaveThis && views.data!.length > 1 && <button className="btn small ghost" onClick={deleteView}>Delete view</button>}
      </div>
      <div className="view-area">
        <Suspense fallback={<Spinner />}>
          {view.type === 'grid' && <GridView {...props} canDelete={canEdit} onLoaded={setLoaded} onAddRecord={addRecord} />}
          {view.type === 'kanban' && <KanbanView {...props} />}
          {view.type === 'gallery' && <GalleryView {...props} />}
          {view.type === 'calendar' && <CalendarView {...props} />}
          {view.type === 'form' && <FormView {...props} canDesign={role >= rank.editor && canSaveThis} />}
        </Suspense>
      </div>
      {openRec && <RecordPanel tableId={tableId} recordId={openRec} fields={t.fields} canEdit={canEdit} canComment={canComment} canDelete={canEdit} onClose={() => setOpenRec(null)} onNavigate={setOpenRec}
        neighbors={{ prev: idx > 0 ? loaded.rows[idx - 1]!.id : undefined, next: idx >= 0 && idx < loaded.rows.length - 1 ? loaded.rows[idx + 1]!.id : undefined }} />}
      {dialog === 'field' && <AddFieldDialog tableId={tableId} onClose={() => setDialog(null)} onCreated={() => { qc.invalidateQueries({ queryKey: qk.table(tableId) }); }} />}
      {dialog === 'import' && <ImportDialog table={t} fields={t.fields} onClose={() => { setDialog(null); qc.invalidateQueries({ queryKey: qk.recordsAll(tableId) }); }} />}
      {dialog === 'newview' && <NewViewDialog tableId={tableId} fields={t.fields} role={role} onClose={() => setDialog(null)} onCreated={(v) => { setDialog(null); navigate(tableUrl(ws.id, tableId, v.id)); }} />}
      {confirmNode}
    </>
  );
}

function NewViewDialog({ tableId, fields, role, onClose, onCreated }: { tableId: string; fields: import('../types').Field[]; role: number; onClose(): void; onCreated(v: View): void }) {
  const [name, setName] = useState(''), [type, setType] = useState<ViewType>('grid'), [visibility, setVisibility] = useState<ViewVisibility>('personal'), [err, setErr] = useState('');
  const save = useSaveView(tableId);
  const qc = useQueryClient();
  const sel = fields.find((f) => f.type === 'single_select'), date = fields.find((f) => ['date', 'datetime'].includes(f.type)), primary = fields.find((f) => f.is_primary) ?? fields[0];
  const needs = type === 'kanban' && !sel ? 'Add a single select field first — board columns come from it.' : type === 'calendar' && !date ? 'Add a date or date-time field first.' : '';
  const config = (): ViewConfig => type === 'kanban' ? { kanban: { groupField: sel!.id } } : type === 'calendar' ? { calendar: { dateField: date!.id, titleField: primary?.id } } : type === 'form' ? { form: { title: name, fields: fields.filter((f) => !['created_time', 'modified_time', 'attachment'].includes(f.type)).slice(0, 8).map((f) => ({ field: f.id, required: f.is_primary })) } } : {};
  return (
    <Dialog title="New view" onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { const v = await save.mutateAsync({ name, type, visibility, config: config() }); await qc.invalidateQueries({ queryKey: qk.views(tableId) }); onCreated(v); } catch (x) { setErr(errText(x)); } }}>
        <div className="field"><label htmlFor="vn">Name</label><input id="vn" className="input" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="vt">Type</label><select id="vt" className="select" value={type} onChange={(e) => setType(e.target.value as ViewType)}>{VIEW_TYPES.map((v) => <option key={v} value={v}>{v[0]!.toUpperCase() + v.slice(1)}</option>)}</select></div>
        <div className="field"><label htmlFor="vv">Visibility</label><select id="vv" className="select" value={visibility} onChange={(e) => setVisibility(e.target.value as ViewVisibility)}>
          <option value="personal">Personal — only you</option>{role >= rank.editor && <option value="shared">Shared — everyone, editors can change it</option>}{role >= rank.admin && <option value="locked">Locked — everyone, only admins can change it</option>}</select></div>
        {needs && <div className="banner warn">{needs}</div>}
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!needs || save.isPending}>Create view</button></div>
      </form>
    </Dialog>
  );
}
