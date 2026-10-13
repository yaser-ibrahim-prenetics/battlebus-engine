BEGIN;

CREATE INDEX idx_refund_operations_active_hold
  ON public.refund_operations (hold_until, created_at)
  WHERE hold_until IS NOT NULL
    AND state NOT IN ('completed', 'dead_letter');

COMMIT;
