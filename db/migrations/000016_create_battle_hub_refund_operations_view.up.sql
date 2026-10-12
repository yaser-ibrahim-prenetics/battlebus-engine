BEGIN;

CREATE VIEW public.battle_hub_refund_operations
WITH (security_barrier = true)
AS
SELECT
  refund_id,
  shopify_order_id,
  event_name,
  state,
  attempts,
  available_at,
  hold_until,
  hold_reason,
  last_error,
  created_at,
  updated_at
FROM public.refund_operations
WHERE state NOT IN ('completed', 'dead_letter');

COMMENT ON VIEW public.battle_hub_refund_operations IS
  'Payload-free projection of active refund recovery and hold state for Battle Hub.';

COMMIT;
