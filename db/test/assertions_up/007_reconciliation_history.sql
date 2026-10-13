INSERT INTO public.reconciliation_history (
  audit_id,
  run_id,
  attempt,
  store_code,
  reconciliation_type,
  trigger_type,
  date_from,
  date_to,
  window_start,
  window_end_exclusive,
  status,
  total_orders,
  matched_orders,
  discrepancy_count,
  details,
  completed_at
)
VALUES (
  '00000000-0000-0000-0000-000000000777',
  'migration-reconciliation-run',
  1,
  'im8',
  'salesorder',
  'manual',
  '2026-10-12',
  '2026-10-12',
  '2026-10-12T00:00:00Z',
  '2026-10-13T00:00:00Z',
  'failed',
  5,
  4,
  1,
  '{"unsyncedOrders":["IM8-MISSING"]}',
  now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.battle_hub_reconciliation_history
    WHERE audit_id = '00000000-0000-0000-0000-000000000777'
      AND discrepancy_count = 1
      AND details->'unsyncedOrders' = '["IM8-MISSING"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'Battle Hub reconciliation history view lost structured details';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.reconciliation_history', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private reconciliation table';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_reconciliation_history',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read reconciliation history';
  END IF;
END
$$;
