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
