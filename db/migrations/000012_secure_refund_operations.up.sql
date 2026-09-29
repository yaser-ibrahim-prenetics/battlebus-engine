BEGIN;

ALTER TABLE public.refund_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.refund_operations FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.refund_operations TO service_role;

CREATE POLICY refund_operations_service_role_all
  ON public.refund_operations
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
