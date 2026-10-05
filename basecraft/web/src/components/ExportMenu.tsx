import { useState } from 'react';
import { downloadExport } from '../api';
import { buildCsv, downloadBlob } from '../lib/csv';
import type { ApiRecord, Field, RecordQuery, TableDetail } from '../types';
import { Popover, errText, useToast } from './ui';

export function ExportMenu(p: { table: TableDetail; fields: Field[]; query: RecordQuery; viewId?: string; loadedRows: ApiRecord[]; visibleFieldIds: string[]; canExport: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const day = new Date().toISOString().slice(0, 10);
  const base = p.table.name.replace(/[^\w.-]+/g, '_') || 'export';

  const serverExport = async (format: 'csv' | 'json') => {
    setBusy(format);
    try {
      const q = p.query;
      const query: Record<string, unknown> = {};
      if (q.search) query.search = q.search;
      if (q.filter) query.filter = q.filter;
      if (q.sort?.length) query.sort = q.sort;
      await downloadExport(p.table.id, { format, query, fields: p.visibleFieldIds }, `${base}-${day}.${format}`);
      toast.push('info', `Export (${format.toUpperCase()}) downloaded`);
    } catch (e) { toast.push('error', errText(e)); } finally { setBusy(null); }
  };

  const localExport = () => {
    downloadBlob(buildCsv(p.fields, p.loadedRows, p.visibleFieldIds), `${base}-loaded-rows-${day}.csv`);
    toast.push('info', `Exported ${p.loadedRows.length} loaded rows`);
  };

  return (
    <Popover label="Export">
      <div className="export-menu">
        <section aria-labelledby="exp-all">
          <h3 id="exp-all">Export all matching records</h3>
          <p className="hint">Runs on the server and includes every record matching the current search and filter, not just the rows loaded here. Exports the visible fields.</p>
          <div className="row">
            <button type="button" className="btn" disabled={!p.canExport || busy !== null} onClick={() => serverExport('csv')}>{busy === 'csv' ? 'Exporting…' : 'CSV'}</button>
            <button type="button" className="btn" disabled={!p.canExport || busy !== null} onClick={() => serverExport('json')}>{busy === 'json' ? 'Exporting…' : 'JSON'}</button>
          </div>
          {!p.canExport && <p className="hint" role="note">Exporting requires the editor role or higher.</p>}
        </section>
        <hr />
        <section aria-labelledby="exp-loaded">
          <h3 id="exp-loaded">Export the rows currently loaded in this grid ({p.loadedRows.length} rows)</h3>
          <p className="hint">This is NOT the full table: only the rows already loaded in your browser are included.</p>
          <button type="button" className="btn" disabled={p.loadedRows.length === 0} onClick={localExport}>Download loaded rows (CSV)</button>
        </section>
      </div>
    </Popover>
  );
}
