-- Basecraft 0001: core schema. Runs as the OWNER role. Application traffic uses basecraft_app (RLS enforced).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'basecraft_app') THEN
    RAISE EXCEPTION 'role basecraft_app does not exist; run `npm run db:init` first';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────── identity (no RLS: needed before a workspace context exists; always filtered explicitly) ─────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  attachment_quota_bytes bigint NOT NULL DEFAULT 524288000,
  deleted_at timestamptz
);

CREATE TABLE members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('viewer','commenter','editor','admin','owner')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user_idx ON members (user_id);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('viewer','commenter','editor','admin')),
  token_hash   bytea NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id)
);
CREATE INDEX invitations_ws_idx ON invitations (workspace_id);

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  token_prefix text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  scopes       text[] NOT NULL,
  base_ids     uuid[],
  table_ids    uuid[],
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  rotated_from uuid REFERENCES api_tokens(id)
);
CREATE INDEX api_tokens_ws_idx ON api_tokens (workspace_id);

-- ───────── workspace content (RLS enforced) ─────────
CREATE TABLE bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id)
);

CREATE TABLE tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id),
  UNIQUE (id, base_id, workspace_id),
  FOREIGN KEY (base_id, workspace_id) REFERENCES bases(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX tables_base_idx ON tables (base_id);

CREATE TABLE fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  position int NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  indexed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id),
  UNIQUE (id, table_id, workspace_id),
  FOREIGN KEY (table_id, workspace_id) REFERENCES tables(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX fields_name_key ON fields (table_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX fields_table_idx ON fields (table_id);

CREATE TABLE records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  table_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size("values") <= 1048576),
  search_text text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (table_id, base_id, workspace_id) REFERENCES tables(id, base_id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX records_table_seq_idx ON records (table_id, seq);
CREATE INDEX records_search_trgm_idx ON records USING gin (search_text gin_trgm_ops);

CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('grid','kanban','gallery','calendar','form')),
  visibility text NOT NULL CHECK (visibility IN ('personal','shared','locked')),
  owner_id uuid NOT NULL REFERENCES users(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (table_id, workspace_id) REFERENCES tables(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX views_table_idx ON views (table_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_id uuid NOT NULL,
  record_id uuid,
  field_id uuid NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'clean' CHECK (status IN ('pending','clean','rejected')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (record_id, workspace_id) REFERENCES records(id, workspace_id) ON DELETE SET NULL (record_id)
);
CREATE INDEX attachments_record_idx ON attachments (record_id) WHERE deleted_at IS NULL;
CREATE INDEX attachments_orphan_idx ON attachments (created_at) WHERE record_id IS NULL OR deleted_at IS NOT NULL;

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  record_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (record_id, workspace_id) REFERENCES records(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX comments_record_idx ON comments (record_id, created_at);

CREATE TABLE resource_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('base','table')),
  resource_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('none','viewer','commenter','editor','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, resource_type, resource_id)
);
CREATE INDEX resource_grants_ws_idx ON resource_grants (workspace_id);

CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  trigger_type text NOT NULL CHECK (trigger_type IN ('record_created','record_updated','condition_matched','form_submitted')),
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb,
  actions jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (table_id, workspace_id) REFERENCES tables(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX automations_table_idx ON automations (table_id) WHERE enabled;

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_id uuid NOT NULL,
  record_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('record.created','record.updated','record.deleted','form.submitted','manual.test')),
  source text NOT NULL CHECK (source IN ('ui','api','import','automation','form','system')),
  chain_id uuid NOT NULL DEFAULT gen_random_uuid(),
  depth int NOT NULL DEFAULT 0,
  visited_automations uuid[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_due_idx ON outbox_events (next_attempt_at) WHERE status IN ('pending','processing');
CREATE INDEX outbox_done_idx ON outbox_events (processed_at) WHERE status = 'done';

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  event_id uuid,
  status text NOT NULL CHECK (status IN ('success','failed','skipped','test')),
  test_mode boolean NOT NULL DEFAULT false,
  attempts int NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms int,
  input jsonb,
  result jsonb,
  error text
);
CREATE INDEX automation_runs_idx ON automation_runs (automation_id, started_at DESC);
CREATE UNIQUE INDEX automation_runs_event_idx ON automation_runs (automation_id, event_id) WHERE event_id IS NOT NULL AND NOT test_mode;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user','token','system')),
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_idx ON audit_events (workspace_id, id DESC);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  created_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  filename text NOT NULL,
  file_key text NOT NULL,
  mapping jsonb NOT NULL,
  options jsonb NOT NULL,
  rows_total int,
  rows_processed int NOT NULL DEFAULT 0,
  rows_created int NOT NULL DEFAULT 0,
  rows_updated int NOT NULL DEFAULT 0,
  rows_skipped int NOT NULL DEFAULT 0,
  rows_failed int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  checkpoint_row int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (table_id, workspace_id) REFERENCES tables(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX import_jobs_due_idx ON import_jobs (created_at) WHERE status IN ('queued','running');

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  fingerprint bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','done')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, key)
);
CREATE INDEX idempotency_expires_idx ON idempotency_keys (expires_at);

-- audit is append-only for everyone, including the owner role, except the retention function below.
CREATE FUNCTION bc_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('basecraft.audit_purge', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION bc_audit_immutable();

-- ───────── row level security: workspace boundary enforced by the database ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bases','tables','fields','records','views','attachments','comments','resource_grants',
    'automations','outbox_events','automation_runs','audit_events','import_jobs','idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY ws_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ───────── privileges for the application role ─────────
GRANT USAGE ON SCHEMA public TO basecraft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, workspaces, members, invitations, api_tokens, bases, tables, fields, records, views,
  attachments, comments, resource_grants, automations, outbox_events, automation_runs, import_jobs, idempotency_keys
  TO basecraft_app;
GRANT SELECT, INSERT ON audit_events TO basecraft_app;   -- no UPDATE/DELETE, ever
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO basecraft_app;

-- ───────── narrow SECURITY DEFINER job interface (the only cross-tenant reads the app role can make) ─────────
CREATE FUNCTION bc_claim_outbox(p_limit int, p_lease_seconds int)
RETURNS SETOF outbox_events LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE outbox_events o SET status = 'processing', attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE o.id IN (
     SELECT id FROM outbox_events
      WHERE status IN ('pending','processing') AND next_attempt_at <= now()
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT p_limit)
  RETURNING o.*;
$$;

CREATE FUNCTION bc_claim_import_job(p_lease_seconds int)
RETURNS SETOF import_jobs LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE import_jobs j SET status = 'running', locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE j.id IN (
     SELECT id FROM import_jobs
      WHERE status IN ('queued','running') AND (locked_until IS NULL OR locked_until < now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING j.*;
$$;

CREATE FUNCTION bc_cleanup(p_audit_retention_days int, p_outbox_retention_days int)
RETURNS TABLE(sessions_deleted bigint, idempotency_deleted bigint, outbox_deleted bigint, audit_deleted bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s bigint; i bigint; o bigint; a bigint;
BEGIN
  DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'; GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM idempotency_keys WHERE expires_at < now(); GET DIAGNOSTICS i = ROW_COUNT;
  DELETE FROM outbox_events WHERE status IN ('done','dead') AND processed_at < now() - make_interval(days => p_outbox_retention_days); GET DIAGNOSTICS o = ROW_COUNT;
  PERFORM set_config('basecraft.audit_purge', 'on', true);
  DELETE FROM audit_events WHERE created_at < now() - make_interval(days => p_audit_retention_days); GET DIAGNOSTICS a = ROW_COUNT;
  PERFORM set_config('basecraft.audit_purge', 'off', true);
  RETURN QUERY SELECT s, i, o, a;
END $$;

CREATE FUNCTION bc_orphan_attachments(p_grace_seconds int, p_limit int)
RETURNS TABLE(id uuid, storage_key text) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.storage_key FROM attachments a
   WHERE (a.record_id IS NULL OR a.deleted_at IS NOT NULL)
     AND coalesce(a.deleted_at, a.created_at) < now() - make_interval(secs => p_grace_seconds)
   LIMIT p_limit;
$$;
CREATE FUNCTION bc_purge_attachment_row(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM attachments WHERE id = p_id AND (record_id IS NULL OR deleted_at IS NOT NULL);
$$;

REVOKE EXECUTE ON FUNCTION bc_claim_outbox, bc_claim_import_job, bc_cleanup, bc_orphan_attachments, bc_purge_attachment_row FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bc_claim_outbox, bc_claim_import_job, bc_cleanup, bc_orphan_attachments, bc_purge_attachment_row TO basecraft_app;
