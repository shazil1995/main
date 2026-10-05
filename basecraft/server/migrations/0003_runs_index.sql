-- Only a SUCCESSFUL (or deliberately skipped) run is unique per (automation, event); failed attempts are recorded separately
-- so a retry is never blocked, while a retry after success can never repeat the side effects.
DROP INDEX automation_runs_event_idx;
CREATE UNIQUE INDEX automation_runs_event_idx ON automation_runs (automation_id, event_id)
  WHERE event_id IS NOT NULL AND NOT test_mode AND status IN ('success','skipped');
