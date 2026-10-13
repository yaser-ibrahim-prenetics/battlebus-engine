BEGIN;

ALTER TABLE public.reconciliation_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reconciliation_history FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.reconciliation_history TO service_role;

CREATE POLICY reconciliation_history_service_role_all
  ON public.reconciliation_history
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE VIEW public.battle_hub_reconciliation_history
WITH (security_barrier = true)
AS
SELECT
  audit_id,
  run_id,
  attempt,
  store_code,
  reconciliation_type,
  trigger_type,
  date_from,
  date_to,
  status,
  total_orders,
  matched_orders,
  discrepancy_count,
  details,
  message,
  error,
  started_at,
  completed_at
FROM public.reconciliation_history;

REVOKE ALL ON TABLE public.battle_hub_reconciliation_history FROM PUBLIC;
GRANT SELECT ON TABLE public.battle_hub_reconciliation_history TO battle_hub_runtime;

COMMENT ON VIEW public.battle_hub_reconciliation_history IS
  'Structured reconciliation audit projection consumed by the Battle Hub history API.';

COMMIT;
