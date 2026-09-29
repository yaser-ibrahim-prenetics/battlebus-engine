BEGIN;

DROP TABLE IF EXISTS public.refund_operations;
DROP FUNCTION IF EXISTS public.battle_platform_scrub_refund_operation_payload();

COMMIT;
