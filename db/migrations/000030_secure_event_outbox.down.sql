BEGIN;

DROP POLICY IF EXISTS event_outbox_service_role_all ON public.event_outbox;
REVOKE ALL ON TABLE public.event_outbox FROM service_role;
ALTER TABLE public.event_outbox DISABLE ROW LEVEL SECURITY;

COMMIT;
