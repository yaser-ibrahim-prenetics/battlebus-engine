BEGIN;

DROP TABLE IF EXISTS public.audit_log;
DROP TABLE IF EXISTS public.audit_entities;
DROP TABLE IF EXISTS public.mission_runs;
DROP TABLE IF EXISTS public.webhook_inbox;
DROP TABLE IF EXISTS public.flow_logs;

COMMIT;
