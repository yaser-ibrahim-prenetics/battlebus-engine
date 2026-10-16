INSERT INTO public.workflow_timeline_events (
  idempotency_key,
  shopify_order_id,
  shopify_order_name,
  source,
  event_type,
  stage,
  status
)
VALUES
  (
    'outbox:00000000-0000-0000-0000-000000000802:pending:0',
    '801', '#IM8-801', 'shopify', 'outbox', 'shopify/order.paid', 'pending'
  ),
  (
    'outbox:00000000-0000-0000-0000-000000000802:processing:1',
    '801', '#IM8-801', 'shopify', 'outbox', 'shopify/order.paid', 'processing'
  ),
  (
    'outbox:00000000-0000-0000-0000-000000000802:published:1',
    '801', '#IM8-801', 'shopify', 'outbox', 'shopify/order.paid', 'published'
  ),
  (
    'flow-log:00000000-0000-0000-0000-000000000804',
    '801', '#IM8-801', 'order_processing', 'workflow', 'complete', 'completed'
  );

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.workflow_timeline_events
    WHERE shopify_order_id = '801'
  ) <> 4 THEN
    RAISE EXCEPTION 'Workflow timeline storage did not preserve all delivery states';
  END IF;
END
$$;
