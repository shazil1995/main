-- OPTIONAL fast-path provisioning. Run ONCE per database as a Postgres SUPERUSER (db-init.sh does this), BEFORE `npm run db:migrate`.
--
-- Why: Basecraft enforces tenant isolation with row-level security. Postgres will not push an operator into an index condition
-- behind an RLS qual unless the operator is LEAKPROOF (cannot reveal row data through errors). jsonb `->>`, numeric casts and
-- LIKE are not marked leakproof, so without these aliases every JSONB filter and every search becomes a table scan
-- (measured: 137 ms -> 0.6 ms for a rare-value filter, 48 ms -> 4 ms for search at 100k rows; see PERFORMANCE.md).
-- Marking functions LEAKPROOF requires superuser, so this cannot live in an ordinary migration. Without it everything still works,
-- just slower at scale (migration 0004 installs equivalent non-leakproof fallbacks).
--
-- Safety argument: both functions are the stock Postgres implementations (`jsonb_object_field_text`, `textlike`), exposed under
-- new names. jsonb_object_field_text never raises on jsonb input. textlike can only raise on a malformed PATTERN (e.g. trailing
-- escape), which depends on the caller-supplied pattern, not on stored data; Basecraft always escapes patterns it builds.

CREATE OR REPLACE FUNCTION bc_jtext(jsonb, text) RETURNS text
  AS 'jsonb_object_field_text' LANGUAGE internal IMMUTABLE STRICT LEAKPROOF PARALLEL SAFE;

CREATE OR REPLACE FUNCTION bc_textlike(text, text) RETURNS boolean
  AS 'textlike' LANGUAGE internal IMMUTABLE STRICT LEAKPROOF PARALLEL SAFE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_operator WHERE oprname = '~~~' AND oprleft = 'text'::regtype AND oprright = 'text'::regtype) THEN
    CREATE OPERATOR ~~~ (LEFTARG = text, RIGHTARG = text, FUNCTION = bc_textlike, RESTRICT = likesel, JOIN = likejoinsel);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'bc_trgm_ops') THEN
    -- a GIN operator class that reuses pg_trgm's support functions but indexes OUR leakproof LIKE operator
    CREATE OPERATOR CLASS bc_trgm_ops FOR TYPE text USING gin AS
      OPERATOR 3 ~~~ (text, text),
      FUNCTION 1 btint4cmp(int4, int4),
      FUNCTION 2 gin_extract_value_trgm(text, internal),
      FUNCTION 3 gin_extract_query_trgm(text, internal, int2, internal, internal, internal, internal),
      FUNCTION 4 gin_trgm_consistent(internal, int2, text, int4, internal, internal, internal, internal),
      FUNCTION 6 gin_trgm_triconsistent(internal, int2, text, int4, internal, internal, internal),
      STORAGE int4;
  END IF;
END $$;
