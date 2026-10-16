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

INSERT INTO public.flow_logs (
  id,
  flow,
  step,
  shopify_order_id,
  shopify_order_name,
  status
)
VALUES (
  '00000000-0000-0000-0000-000000000804',
  'order_processing',
  'complete',
  '801',
  '#IM8-801',
  'completed'
);

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.battle_hub_workflow_timeline
    WHERE shopify_order_id = '801'
  ) < 4 THEN
    RAISE EXCEPTION 'Workflow timeline did not capture durable delivery and flow transitions';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.event_outbox', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private event outbox';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.workflow_timeline_events', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private timeline table';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_workflow_timeline',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read the workflow timeline view';
  END IF;
END
$$;
