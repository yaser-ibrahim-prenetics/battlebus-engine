BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO public.workflow_run_health (run_id, function_id, event_name, revision, received_at)
VALUES ('fixture-health', 'process-order', 'order/received', repeat('a',40), now());
UPDATE public.workflow_run_health SET status = 'completed', completed_at = now(), attempts = 2
WHERE run_id = 'fixture-health';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_run_health
    WHERE run_id = 'fixture-health' AND status = 'completed' AND attempts = 2) THEN
    RAISE EXCEPTION 'Workflow health did not persist';
  END IF;
  BEGIN
    UPDATE public.workflow_run_health SET completed_at = NULL WHERE run_id = 'fixture-health';
    RAISE EXCEPTION 'Terminal workflow accepted missing completion time';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;
RESET ROLE;

ROLLBACK;
