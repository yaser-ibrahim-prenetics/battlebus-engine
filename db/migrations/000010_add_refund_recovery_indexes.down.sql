BEGIN;

DROP INDEX IF EXISTS public.idx_refund_operations_shopify_order;
DROP INDEX IF EXISTS public.idx_refund_operations_expired_dispatch;
DROP INDEX IF EXISTS public.idx_refund_operations_recovery;

COMMIT;
