BEGIN;

CREATE INDEX IF NOT EXISTS idx_refund_operations_recovery
  ON public.refund_operations (available_at, created_at)
  WHERE state = 'awaiting_order';

CREATE INDEX IF NOT EXISTS idx_refund_operations_expired_claim
  ON public.refund_operations (lease_expires_at)
  WHERE state IN ('dispatching', 'processing', 'creating_line', 'line_created');

CREATE INDEX IF NOT EXISTS idx_refund_operations_shopify_order
  ON public.refund_operations (shopify_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_operations_dead_letter
  ON public.refund_operations (dead_lettered_at DESC)
  WHERE state = 'dead_letter';

COMMIT;
