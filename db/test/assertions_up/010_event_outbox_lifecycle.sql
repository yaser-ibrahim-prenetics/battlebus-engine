INSERT INTO public.event_outbox (
  id,
  inbox_id,
  source,
  topic,
  schema_version,
  event_name,
  event_id,
  event_data,
  idempotency_key,
  shopify_order_id,
  shopify_order_name
)
VALUES (
  '00000000-0000-0000-0000-000000000802',
  '00000000-0000-0000-0000-000000000801',
  'shopify',
  'orders/paid',
  '1.0',
  'shopify/order.paid',
  'shopify-paid-801',
  '{"shopifyOrderId":"801","shopifyOrderName":"#IM8-801"}',
  'shopify-paid-801',
  '801',
  '#IM8-801'
);

UPDATE public.event_outbox
SET state = 'processing',
    attempts = 1,
    claim_token = '00000000-0000-4000-8000-000000000803',
    lease_expires_at = now() + interval '5 minutes'
WHERE id = '00000000-0000-0000-0000-000000000802';

UPDATE public.event_outbox
SET state = 'published',
    claim_token = NULL,
    lease_expires_at = NULL,
    published_at = now()
WHERE id = '00000000-0000-0000-0000-000000000802';

DO $$
BEGIN
  IF (
    SELECT state
    FROM public.event_outbox
    WHERE id = '00000000-0000-0000-0000-000000000802'
  ) IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'Event outbox lifecycle did not reach published state';
  END IF;
END
$$;
