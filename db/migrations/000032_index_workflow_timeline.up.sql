BEGIN;

CREATE INDEX idx_workflow_timeline_order_id
  ON public.workflow_timeline_events (shopify_order_id, occurred_at, id);
CREATE INDEX idx_workflow_timeline_order_name
  ON public.workflow_timeline_events (shopify_order_name, occurred_at, id);
CREATE INDEX idx_workflow_timeline_status
  ON public.workflow_timeline_events (status, occurred_at DESC);

COMMIT;
