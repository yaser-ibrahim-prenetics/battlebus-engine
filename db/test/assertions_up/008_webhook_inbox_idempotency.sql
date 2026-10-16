INSERT INTO public.webhook_inbox (
  id,
  source,
  topic,
  payload,
  events,
  idempotency_key,
  schema_version,
  payload_hash
)
VALUES (
  '00000000-0000-0000-0000-000000000801',
  'shopify',
  'orders/paid',
  '{"id":"801"}',
  '[{"name":"shopify/order.paid","id":"shopify-paid-801","data":{"shopifyOrderId":"801","shopifyOrderName":"#IM8-801"}}]',
  'shopify:orders/paid:801',
  '1.0',
  'hash-801'
);

INSERT INTO public.webhook_inbox (
  source,
  topic,
  payload,
  idempotency_key,
  schema_version,
  payload_hash
)
VALUES (
  'shopify',
  'orders/paid',
  '{"id":"801"}',
  'shopify:orders/paid:801',
  '1.0',
  'hash-801'
)
ON CONFLICT (source, idempotency_key) DO UPDATE
SET duplicate_count = public.webhook_inbox.duplicate_count + 1;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.webhook_inbox
    WHERE source = 'shopify'
      AND idempotency_key = 'shopify:orders/paid:801'
  ) <> 1 THEN
    RAISE EXCEPTION 'Webhook inbox idempotency did not collapse a duplicate receipt';
  END IF;

  IF (
    SELECT duplicate_count
    FROM public.webhook_inbox
    WHERE source = 'shopify'
      AND idempotency_key = 'shopify:orders/paid:801'
  ) <> 1 THEN
    RAISE EXCEPTION 'Webhook inbox duplicate counter was not incremented';
  END IF;
END
$$;
