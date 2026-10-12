BEGIN;

ALTER TABLE public.refund_operations
  ADD COLUMN hold_until timestamptz,
  ADD COLUMN hold_reason text,
  ADD CONSTRAINT refund_operations_hold_metadata_consistent
    CHECK ((hold_until IS NULL) = (hold_reason IS NULL)),
  ADD CONSTRAINT refund_operations_hold_deadline_consistent
    CHECK (hold_until IS NULL OR available_at >= hold_until);

CREATE INDEX idx_refund_operations_active_hold
  ON public.refund_operations (hold_until, created_at)
  WHERE hold_until IS NOT NULL
    AND state NOT IN ('completed', 'dead_letter');

COMMENT ON COLUMN public.refund_operations.hold_until IS
  'Earliest processing time for a refund held because its webhook line snapshot was unfulfilled.';
COMMENT ON COLUMN public.refund_operations.hold_reason IS
  'Machine-readable reason for a refund hold; currently unfulfilled_refund_line.';

COMMIT;
