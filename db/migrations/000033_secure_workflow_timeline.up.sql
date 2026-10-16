BEGIN;

ALTER TABLE public.workflow_timeline_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_timeline_events FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.workflow_timeline_events TO service_role;

CREATE POLICY workflow_timeline_events_service_role_all
  ON public.workflow_timeline_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
