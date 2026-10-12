BEGIN;

ALTER TABLE public.refund_operations
  DROP COLUMN IF EXISTS hold_reason,
  DROP COLUMN IF EXISTS hold_until;

COMMIT;
