INSERT INTO public.refund_operations (
  refund_id, shopify_order_id, event_data, state, claim_token, lease_expires_at
)
VALUES (
  'migration-refund-dedupe', 'migration-order', '{"private":"payload"}', 'processing',
  '00000000-0000-0000-0000-000000000099', now() + interval '5 minutes'
)
ON CONFLICT (refund_id) DO NOTHING;

INSERT INTO public.refund_operations (
  refund_id, shopify_order_id, event_data, state, claim_token, lease_expires_at
)
VALUES (
  'migration-refund-dedupe', 'migration-order', '{"private":"duplicate"}', 'processing',
  '00000000-0000-0000-0000-000000000098', now() + interval '5 minutes'
)
ON CONFLICT (refund_id) DO NOTHING;

UPDATE public.refund_operations
SET state = 'completed', claim_token = NULL, lease_expires_at = NULL
WHERE refund_id = 'migration-refund-dedupe';

DO $$
BEGIN
  IF (SELECT count(*) FROM public.refund_operations WHERE refund_id = 'migration-refund-dedupe') <> 1 THEN
    RAISE EXCEPTION 'Refund operation primary key did not prevent a duplicate refund';
  END IF;

  IF (SELECT event_data FROM public.refund_operations WHERE refund_id = 'migration-refund-dedupe') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Completed refund operation payload was not scrubbed';
  END IF;
END
$$;

INSERT INTO public.refund_operations (
  refund_id, shopify_order_id, event_data, state, available_at, hold_until, hold_reason
)
VALUES (
  'migration-refund-hold', 'migration-held-order', '{"private":"held-payload"}',
  'awaiting_order', now() + interval '24 hours', now() + interval '24 hours',
  'unfulfilled_refund_line'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.battle_hub_refund_operations
    WHERE refund_id = 'migration-refund-hold'
      AND shopify_order_id = 'migration-held-order'
      AND hold_reason = 'unfulfilled_refund_line'
      AND hold_until IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Battle Hub refund-operation view does not expose active hold metadata';
  END IF;
END
$$;

INSERT INTO public.refund_operations (
  refund_id, shopify_order_id, event_data, state, dead_lettered_at
)
VALUES (
  'migration-refund-dead-letter', 'migration-order', '{"private":"dead-letter-payload"}',
  'dead_letter', now()
);

DO $$
BEGIN
  IF (
    SELECT event_data
    FROM public.refund_operations
    WHERE refund_id = 'migration-refund-dead-letter'
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Dead-lettered refund operation payload was not scrubbed';
  END IF;
END
$$;
