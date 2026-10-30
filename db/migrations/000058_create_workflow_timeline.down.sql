BEGIN;
DROP TRIGGER capture_workflow_timeline ON public.flow_logs;
DROP FUNCTION public.capture_workflow_timeline();
DROP VIEW public.battle_hub_workflow_timeline;
DROP TABLE public.workflow_timeline_events;
COMMIT;
