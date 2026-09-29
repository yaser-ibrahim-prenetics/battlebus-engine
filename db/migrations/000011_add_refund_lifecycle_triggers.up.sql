BEGIN;

CREATE OR REPLACE FUNCTION public.battle_platform_scrub_refund_operation_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state IN ('completed', 'dead_letter') THEN
    NEW.event_data := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS battle_platform_scrub_refund_operation_payload
  ON public.refund_operations;
CREATE TRIGGER battle_platform_scrub_refund_operation_payload
  BEFORE INSERT OR UPDATE ON public.refund_operations
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_scrub_refund_operation_payload();

DROP TRIGGER IF EXISTS battle_platform_refund_operations_updated_at
  ON public.refund_operations;
CREATE TRIGGER battle_platform_refund_operations_updated_at
  BEFORE UPDATE ON public.refund_operations
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

COMMIT;
