BEGIN;

DROP POLICY IF EXISTS refund_operations_service_role_all
  ON public.refund_operations;
REVOKE ALL ON TABLE public.refund_operations FROM service_role;
ALTER TABLE public.refund_operations DISABLE ROW LEVEL SECURITY;

COMMIT;
