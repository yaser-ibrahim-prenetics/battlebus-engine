BEGIN;

DROP INDEX IF EXISTS public.idx_workflow_timeline_status;
DROP INDEX IF EXISTS public.idx_workflow_timeline_order_name;
DROP INDEX IF EXISTS public.idx_workflow_timeline_order_id;

COMMIT;
