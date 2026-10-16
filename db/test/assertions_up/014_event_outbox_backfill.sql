DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.event_outbox
    WHERE inbox_id = '00000000-0000-0000-0000-000000000835'
  ) <> 2 THEN
    RAISE EXCEPTION 'Retryable legacy webhook events were not backfilled into the outbox';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.event_outbox
    WHERE inbox_id = '00000000-0000-0000-0000-000000000835'
      AND idempotency_key = 'shopify:event:legacy-paid-835'
      AND state = 'pending'
      AND attempts = 2
      AND last_error = 'legacy delivery failure'
      AND error_class = 'unknown'
      AND recovery_action = 'retry'
      AND shopify_order_id = '835'
      AND shopify_order_name = '#IM8-835'
  ) THEN
    RAISE EXCEPTION 'Legacy webhook retry state was not preserved by the outbox backfill';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.event_outbox
    WHERE inbox_id = '00000000-0000-0000-0000-000000000835'
      AND idempotency_key = 'shopify:legacy-webhook-835:1:shopify/order.tagged'
      AND event_id IS NOT NULL
      AND shopify_order_id = '835'
      AND shopify_order_name = '#IM8-835'
  ) THEN
    RAISE EXCEPTION 'Legacy webhook event identity was not reconstructed deterministically';
  END IF;
END
$$;
