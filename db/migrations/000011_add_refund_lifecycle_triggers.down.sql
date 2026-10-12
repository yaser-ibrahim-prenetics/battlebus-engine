BEGIN;

DROP TRIGGER IF EXISTS battle_platform_refund_operations_updated_at
  ON public.refund_operations;
DROP TRIGGER IF EXISTS battle_platform_scrub_refund_operation_payload
  ON public.refund_operations;
DROP FUNCTION IF EXISTS public.battle_platform_scrub_refund_operation_payload();

COMMIT;
