-- Resolve a resource id to its owning workspace/base/table. Returns ids only (no tenant data); callers MUST then
-- verify the principal's membership and respond 404 on any mismatch so ids cannot be probed.
CREATE FUNCTION bc_resolve(p_kind text, p_id uuid)
RETURNS TABLE(workspace_id uuid, base_id uuid, table_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_kind = 'base' THEN
    RETURN QUERY SELECT b.workspace_id, b.id, NULL::uuid FROM bases b WHERE b.id = p_id AND b.deleted_at IS NULL;
  ELSIF p_kind = 'table' THEN
    RETURN QUERY SELECT t.workspace_id, t.base_id, t.id FROM tables t JOIN bases b ON b.id = t.base_id
      WHERE t.id = p_id AND t.deleted_at IS NULL AND b.deleted_at IS NULL;
  ELSIF p_kind = 'field' THEN
    RETURN QUERY SELECT t.workspace_id, t.base_id, t.id FROM fields f JOIN tables t ON t.id = f.table_id
      WHERE f.id = p_id AND f.deleted_at IS NULL AND t.deleted_at IS NULL;
  ELSIF p_kind = 'record' THEN
    RETURN QUERY SELECT r.workspace_id, r.base_id, r.table_id FROM records r JOIN tables t ON t.id = r.table_id
      WHERE r.id = p_id AND t.deleted_at IS NULL;
  ELSIF p_kind = 'view' THEN
    RETURN QUERY SELECT v.workspace_id, t.base_id, t.id FROM views v JOIN tables t ON t.id = v.table_id
      WHERE v.id = p_id AND t.deleted_at IS NULL;
  ELSIF p_kind = 'attachment' THEN
    RETURN QUERY SELECT a.workspace_id, t.base_id, t.id FROM attachments a JOIN tables t ON t.id = a.table_id
      WHERE a.id = p_id AND a.deleted_at IS NULL;
  ELSIF p_kind = 'automation' THEN
    RETURN QUERY SELECT a.workspace_id, t.base_id, t.id FROM automations a JOIN tables t ON t.id = a.table_id WHERE a.id = p_id;
  ELSIF p_kind = 'import_job' THEN
    RETURN QUERY SELECT j.workspace_id, t.base_id, t.id FROM import_jobs j JOIN tables t ON t.id = j.table_id WHERE j.id = p_id;
  ELSIF p_kind = 'token' THEN
    RETURN QUERY SELECT k.workspace_id, NULL::uuid, NULL::uuid FROM api_tokens k WHERE k.id = p_id;
  ELSIF p_kind = 'invitation' THEN
    RETURN QUERY SELECT i.workspace_id, NULL::uuid, NULL::uuid FROM invitations i WHERE i.id = p_id;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION bc_resolve FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bc_resolve TO basecraft_app;
