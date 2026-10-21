SET LOCAL ROLE service_role;
INSERT INTO public.workflow_run_health
  (run_id, function_id, event_name, revision, received_at, status, completed_at, sample_excluded)
VALUES ('fixture-skipped', 'process-order', 'fixture', repeat('a',40), now(), 'completed', now(), true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_run_health
    WHERE run_id = 'fixture-skipped' AND sample_excluded) THEN
    RAISE EXCEPTION 'Skipped invocation lost its exclusion flag';
  END IF;
END
$$;
RESET ROLE;
