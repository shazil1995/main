import type { Client } from './db.js';
import type { Actor } from './types.js';

export interface AuditInput {
  workspaceId: string;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string;
  traceId?: string;
}

/** Appends an immutable audit row inside the caller's transaction (so it commits atomically with the change). */
export async function audit(c: Client, a: AuditInput): Promise<void> {
  await c.query(
    `INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.workspaceId, a.actor.type, a.actor.id, a.action, a.targetType ?? null, a.targetId ?? null, JSON.stringify(a.metadata ?? {}), a.ip ?? null, a.traceId ?? null],
  );
}

export async function auditMany(c: Client, rows: AuditInput[]): Promise<void> {
  if (!rows.length) return;
  await c.query(
    `INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, trace_id)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::uuid[], $7::jsonb[], $8::text[], $9::text[])`,
    [
      rows.map((r) => r.workspaceId), rows.map((r) => r.actor.type), rows.map((r) => r.actor.id), rows.map((r) => r.action),
      rows.map((r) => r.targetType ?? null), rows.map((r) => r.targetId ?? null), rows.map((r) => JSON.stringify(r.metadata ?? {})),
      rows.map((r) => r.ip ?? null), rows.map((r) => r.traceId ?? null),
    ],
  );
}
