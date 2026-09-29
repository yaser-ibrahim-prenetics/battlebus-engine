BEGIN;

DROP INDEX IF EXISTS public.idx_refund_operations_dead_letter;
DROP INDEX IF EXISTS public.idx_refund_operations_shopify_order;
DROP INDEX IF EXISTS public.idx_refund_operations_expired_claim;
DROP INDEX IF EXISTS public.idx_refund_operations_recovery;

COMMIT;
