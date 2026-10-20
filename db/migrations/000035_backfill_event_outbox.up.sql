BEGIN;

WITH legacy_events AS (
  SELECT
    receipt.id AS inbox_id,
    receipt.source,
    receipt.topic,
    receipt.schema_version,
    receipt.idempotency_key AS inbox_idempotency_key,
    receipt.status AS inbox_status,
    receipt.attempts,
    receipt.last_error,
    queued.position - 1 AS event_index,
    btrim(queued.event->>'name') AS event_name,
    NULLIF(btrim(queued.event->>'id'), '') AS event_id,
    CASE
      WHEN jsonb_typeof(queued.event->'data') = 'object' THEN queued.event->'data'
      ELSE '{}'::jsonb
    END AS event_data
  FROM public.webhook_inbox AS receipt
  CROSS JOIN LATERAL jsonb_array_elements(receipt.events)
    WITH ORDINALITY AS queued(event, position)
  WHERE receipt.status IN ('received', 'failed')
    AND jsonb_typeof(queued.event) = 'object'
    AND NULLIF(btrim(queued.event->>'name'), '') IS NOT NULL
)
INSERT INTO public.event_outbox (
  inbox_id,
  source,
  topic,
  schema_version,
  event_name,
  event_id,
  event_data,
  idempotency_key,
  shopify_order_id,
  shopify_order_name,
  attempts,
  last_error,
  error_class,
  recovery_action
)
SELECT
  legacy.inbox_id,
  legacy.source,
  legacy.topic,
  legacy.schema_version,
  legacy.event_name,
  COALESCE(
    legacy.event_id,
    encode(
      sha256(
        convert_to(concat(
          legacy.source,
          ':',
          legacy.inbox_idempotency_key,
          ':',
          legacy.event_index,
          ':',
          legacy.event_name
        ), 'UTF8')
      ),
      'hex'
    )
  ),
  legacy.event_data,
  CASE
    WHEN legacy.event_id IS NOT NULL THEN concat(legacy.source, ':event:', legacy.event_id)
    ELSE concat(
      legacy.source,
      ':',
      legacy.inbox_idempotency_key,
      ':',
      legacy.event_index,
      ':',
      legacy.event_name
    )
  END,
  COALESCE(
    legacy.event_data->>'shopifyOrderId',
    legacy.event_data->>'shopify_order_id',
    legacy.event_data#>>'{order,shopifyOrderId}',
    legacy.event_data#>>'{order,shopify_order_id}',
    legacy.event_data#>>'{order,id}'
  ),
  COALESCE(
    legacy.event_data->>'shopifyOrderName',
    legacy.event_data->>'shopify_order_name',
    legacy.event_data->>'orderName',
    legacy.event_data#>>'{order,shopifyOrderName}',
    legacy.event_data#>>'{order,shopify_order_name}',
    legacy.event_data#>>'{order,name}'
  ),
  legacy.attempts,
  legacy.last_error,
  CASE WHEN legacy.inbox_status = 'failed' THEN 'unknown' END,
  CASE WHEN legacy.inbox_status = 'failed' THEN 'retry' END
FROM legacy_events AS legacy
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
