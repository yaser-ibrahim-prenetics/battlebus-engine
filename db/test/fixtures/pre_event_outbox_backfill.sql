INSERT INTO public.webhook_inbox (
  id,
  source,
  topic,
  payload,
  events,
  status,
  attempts,
  last_error,
  idempotency_key,
  schema_version,
  payload_hash
)
VALUES (
  '00000000-0000-0000-0000-000000000835',
  'shopify',
  'orders/paid',
  '{"id":"835"}',
  '[
    {
      "name":"shopify/order.paid",
      "id":"legacy-paid-835",
      "data":{"shopifyOrderId":"835","shopifyOrderName":"#IM8-835"}
    },
    {
      "name":"shopify/order.tagged",
      "data":{"order":{"id":"835","name":"#IM8-835"}}
    }
  ]',
  'failed',
  2,
  'legacy delivery failure',
  'legacy-webhook-835',
  '1.0',
  'legacy-hash-835'
);
