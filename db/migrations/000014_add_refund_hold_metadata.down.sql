BEGIN;

DROP INDEX IF EXISTS public.idx_refund_operations_active_hold;

ALTER TABLE public.refund_operations
  DROP COLUMN IF EXISTS hold_reason,
  DROP COLUMN IF EXISTS hold_until;

COMMIT;
