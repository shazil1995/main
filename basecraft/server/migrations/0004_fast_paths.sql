-- Query helpers used by every JSONB filter/sort/search. If sql/leakproof.sql was applied by a superuser these already exist as
-- LEAKPROOF aliases of stock Postgres functions (fast, index-friendly under RLS). Otherwise equivalent plain fallbacks are created
-- here: identical results, but filters/search fall back to scans behind RLS. Never edit this file after it has been applied.
DO $$ BEGIN
  IF to_regprocedure('bc_jtext(jsonb,text)') IS NULL THEN
    CREATE FUNCTION bc_jtext(jsonb, text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT $1 ->> $2';
  END IF;
  IF to_regprocedure('bc_textlike(text,text)') IS NULL THEN
    CREATE FUNCTION bc_textlike(text, text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT $1 LIKE $2';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_operator WHERE oprname = '~~~' AND oprleft = 'text'::regtype AND oprright = 'text'::regtype) THEN
    CREATE OPERATOR ~~~ (LEFTARG = text, RIGHTARG = text, FUNCTION = bc_textlike, RESTRICT = likesel, JOIN = likejoinsel);
  END IF;
END $$;

-- The stock trigram index can never be used behind RLS (LIKE is not leakproof): replace it.
DROP INDEX IF EXISTS records_search_trgm_idx;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'bc_trgm_ops') THEN
    CREATE INDEX records_search_idx ON records USING gin (search_text bc_trgm_ops);
  END IF;
END $$;

-- Per-field expression indexes built before this migration used expressions the planner can no longer match: drop them and
-- clear the flag so owners can re-enable them (re-creation runs CONCURRENTLY, which a migration transaction cannot do).
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'records' AND indexname LIKE 'rx\_%' LOOP
    EXECUTE format('DROP INDEX %I', r.indexname);
  END LOOP;
END $$;
UPDATE fields SET indexed = false WHERE indexed;

GRANT EXECUTE ON FUNCTION bc_jtext(jsonb, text), bc_textlike(text, text) TO basecraft_app;
