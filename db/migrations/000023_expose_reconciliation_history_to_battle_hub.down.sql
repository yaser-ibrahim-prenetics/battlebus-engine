BEGIN;

DROP VIEW IF EXISTS public.battle_hub_reconciliation_history;
DROP POLICY IF EXISTS reconciliation_history_service_role_all
  ON public.reconciliation_history;
REVOKE ALL ON TABLE public.reconciliation_history FROM service_role;
ALTER TABLE public.reconciliation_history DISABLE ROW LEVEL SECURITY;

COMMIT;
