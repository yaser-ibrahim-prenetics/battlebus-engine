BEGIN;

DROP POLICY IF EXISTS workflow_timeline_events_service_role_all
  ON public.workflow_timeline_events;
REVOKE ALL ON TABLE public.workflow_timeline_events FROM service_role;
ALTER TABLE public.workflow_timeline_events DISABLE ROW LEVEL SECURITY;

COMMIT;
