import type { FastifyBaseLogger } from 'fastify';
import { AutomationRow, runActions, triggerMatches } from './automations.js';
import { withWorkspace } from './db.js';
import { loadFields } from './records.js';
import type { AppContext } from './http.js';
import { runImportJob } from './importer.js';
import { cleanupOrphanAttachments } from './routes/attachments.js';
import { HttpError } from './errors.js';

interface OutboxRow {
  id: number; event_id: string; workspace_id: string; table_id: string; record_id: string; type: string; source: string;
  chain_id: string; depth: number; visited_automations: string[]; payload: any; attempts: number;
}

const backoffMs = (attempts: number) => Math.min(300_000, 2000 * 2 ** (attempts - 1)) + Math.floor(Math.random() * 1000);

/**
 * Durable job worker. Everything it does is driven by rows in Postgres (outbox_events, import_jobs) claimed with
 * FOR UPDATE SKIP LOCKED leases, so a crash or restart loses nothing: expired leases are simply claimed again.
 * Delivery is at-least-once; the unique successful-run index makes automation side effects effectively-once per event.
 */
export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];
  private lastMaintenance = 0;
  constructor(private app: AppContext, private log: FastifyBaseLogger, private opts = { leaseSeconds: 60, idleMinMs: 200, idleMaxMs: 2000 }) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.loops = [this.loop(() => this.tickOutbox()), this.loop(() => this.tickImports()), this.loop(() => this.maintenance(), 30_000)];
  }
  async stop() { this.running = false; await Promise.all(this.loops); }

  private async loop(tick: () => Promise<boolean>, fixedDelay?: number) {
    let idle = this.opts.idleMinMs;
    while (this.running) {
      let worked = false;
      try { worked = await tick(); } catch (err) { this.log.error({ err }, 'worker tick failed'); }
      if (!this.running) break;
      if (fixedDelay) { await sleep(fixedDelay, () => this.running); continue; }
      if (worked) idle = this.opts.idleMinMs; else { await sleep(idle, () => this.running); idle = Math.min(idle * 2, this.opts.idleMaxMs); }
    }
  }

  /** Process every currently-due event once (used by tests and the CLI). Returns events handled. */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    for (;;) {
      const k = await this.processBatch();
      n += k;
      if (!k || n >= max) return n;
    }
  }

  /** Run queued/expired import jobs to completion (used by tests and the CLI). */
  async drainJobs(): Promise<number> {
    let n = 0;
    while (await this.tickImports()) n++;
    return n;
  }

  private async tickOutbox(): Promise<boolean> { return (await this.processBatch()) > 0; }

  private async processBatch(): Promise<number> {
    const n = Math.max(1, this.app.config.WORKER_CONCURRENCY);
    const claimed = (await this.app.db.app.query(`SELECT * FROM bc_claim_outbox($1, $2)`, [n, this.opts.leaseSeconds])).rows as OutboxRow[];
    await Promise.all(claimed.map((ev) => this.processEvent(ev)));
    return claimed.length;
  }

  private async processEvent(ev: OutboxRow): Promise<void> {
    const app = this.app;
    const failures: string[] = [];
    try {
      const autos = await withWorkspace(app.db, ev.workspace_id, async (c) =>
        (await c.query(`SELECT id, table_id, name, enabled, trigger_type, trigger_config, conditions, actions FROM automations WHERE table_id=$1 AND enabled`, [ev.table_id])).rows as AutomationRow[]);
      if (autos.length) {
        const { fields, base, rec } = await withWorkspace(app.db, ev.workspace_id, async (c) => ({
          fields: await loadFields(c, ev.table_id),
          base: (await c.query(`SELECT base_id FROM tables WHERE id=$1`, [ev.table_id])).rows[0]?.base_id as string | undefined,
          rec: (await c.query(`SELECT created_at, updated_at FROM records WHERE id=$1`, [ev.record_id])).rows[0],
        }));
        const meta = { created_at: rec?.created_at?.toISOString(), updated_at: rec?.updated_at?.toISOString() };
        for (const a of autos) {
          if (!triggerMatches(a, { type: ev.type, record_id: ev.record_id, payload: ev.payload }, fields, meta)) continue;
          const t0 = Date.now();
          try {
            await withWorkspace(app.db, ev.workspace_id, async (c) => {
              const done = await c.query(`SELECT 1 FROM automation_runs WHERE automation_id=$1 AND event_id=$2 AND status IN ('success','skipped') AND NOT test_mode`, [a.id, ev.event_id]);
              if (done.rowCount) return; // a previous attempt already committed this run
              const skipReason = ev.visited_automations.includes(a.id) ? 'loop_guard: this automation already ran in the same chain' : ev.depth >= app.config.AUTOMATION_MAX_DEPTH ? `depth_limit: chain depth ${ev.depth} reached the limit of ${app.config.AUTOMATION_MAX_DEPTH}` : null;
              const input = JSON.stringify({ event_type: ev.type, record_id: ev.record_id, source: ev.source, depth: ev.depth, changed_fields: ev.payload.changed ?? null });
              if (skipReason) {
                await c.query(`INSERT INTO automation_runs (workspace_id, automation_id, event_id, status, attempts, finished_at, duration_ms, input, error) VALUES ($1,$2,$3,'skipped',$4,now(),0,$5,$6)`, [ev.workspace_id, a.id, ev.event_id, ev.attempts, input, skipReason]);
                return;
              }
              const effects = await runActions({
                c, workspaceId: ev.workspace_id, baseId: base!, tableId: ev.table_id, actor: { type: 'system', id: null }, source: 'automation',
                chainId: ev.chain_id, depth: ev.depth + 1, visited: [...ev.visited_automations, a.id],
              }, a, ev.record_id, ev.payload.after ?? {}, false);
              await c.query(`INSERT INTO automation_runs (workspace_id, automation_id, event_id, status, attempts, finished_at, duration_ms, input, result) VALUES ($1,$2,$3,'success',$4,now(),$5,$6,$7)`,
                [ev.workspace_id, a.id, ev.event_id, ev.attempts, Date.now() - t0, input, JSON.stringify({ effects: effects.map((e) => ({ action: e.action, table_id: e.table_id, record_id: e.record_id, fields: Object.keys(e.set) })) })]);
            });
          } catch (err) {
            const msg = err instanceof HttpError ? `${err.message}${Array.isArray(err.details) ? ': ' + (err.details as any[]).map((d) => d.message).join('; ') : ''}` : 'Internal error while running the automation';
            if (!(err instanceof HttpError)) this.log.error({ err, automation: a.id }, 'automation run crashed');
            failures.push(`${a.name}: ${msg}`);
            await withWorkspace(app.db, ev.workspace_id, (c) => c.query(
              `INSERT INTO automation_runs (workspace_id, automation_id, event_id, status, attempts, finished_at, duration_ms, input, error) VALUES ($1,$2,$3,'failed',$4,now(),$5,$6,$7)`,
              [ev.workspace_id, a.id, ev.event_id, ev.attempts, Date.now() - t0, JSON.stringify({ event_type: ev.type, record_id: ev.record_id, depth: ev.depth }), msg])).catch(() => {});
          }
        }
      }
    } catch (err) {
      this.log.error({ err, event: ev.event_id }, 'event processing crashed');
      failures.push('Internal error');
    }
    await withWorkspace(app.db, ev.workspace_id, async (c) => {
      if (!failures.length) { await c.query(`UPDATE outbox_events SET status='done', processed_at=now(), locked_until=NULL, last_error=NULL WHERE id=$1`, [ev.id]); return; }
      const dead = ev.attempts >= app.config.AUTOMATION_MAX_ATTEMPTS;
      await c.query(
        `UPDATE outbox_events SET status=$2, locked_until=NULL, last_error=$3, processed_at=CASE WHEN $2='dead' THEN now() ELSE NULL END, next_attempt_at = now() + make_interval(secs => $4::float / 1000) WHERE id=$1`,
        [ev.id, dead ? 'dead' : 'pending', failures.join(' | ').slice(0, 1000), backoffMs(ev.attempts)]);
      if (dead) await c.query(`INSERT INTO audit_events (workspace_id, actor_type, action, target_type, target_id, metadata) VALUES ($1,'system','automation.dead_letter','record',$2,$3)`, [ev.workspace_id, ev.record_id, JSON.stringify({ event_id: ev.event_id, error: failures.join(' | ').slice(0, 500) })]);
    });
  }

  private async tickImports(): Promise<boolean> {
    const row = (await this.app.db.app.query(`SELECT * FROM bc_claim_import_job($1)`, [this.opts.leaseSeconds])).rows[0];
    if (!row) return false;
    const job = { ...row, mapping: row.mapping, options: row.options };
    const heartbeat = async () => { await withWorkspace(this.app.db, job.workspace_id, (c) => c.query(`UPDATE import_jobs SET locked_until=now()+make_interval(secs => $2) WHERE id=$1`, [job.id, this.opts.leaseSeconds])); };
    await runImportJob(this.app, job, heartbeat);
    return true;
  }

  private async maintenance(): Promise<boolean> {
    if (Date.now() - this.lastMaintenance < 10 * 60_000 && this.lastMaintenance) return false;
    this.lastMaintenance = Date.now();
    const c = this.app.config;
    const r = (await this.app.db.app.query(`SELECT * FROM bc_cleanup($1, $2)`, [c.AUDIT_RETENTION_DAYS, c.OUTBOX_RETENTION_DAYS])).rows[0];
    const orphans = await cleanupOrphanAttachments(this.app);
    this.log.info({ ...r, orphan_attachments: orphans }, 'maintenance');
    return false;
  }
}

function sleep(ms: number, alive: () => boolean): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms); t.unref?.();
    const iv = setInterval(() => { if (!alive()) { clearTimeout(t); clearInterval(iv); res(); } }, 250); iv.unref?.();
    setTimeout(() => clearInterval(iv), ms + 10).unref?.();
  });
}
