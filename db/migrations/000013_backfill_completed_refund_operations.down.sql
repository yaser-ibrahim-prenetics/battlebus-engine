BEGIN;

DELETE FROM public.refund_operations
WHERE backfilled_at IS NOT NULL;

COMMIT;
