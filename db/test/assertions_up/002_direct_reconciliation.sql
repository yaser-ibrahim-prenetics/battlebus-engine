DO $$
BEGIN
  IF to_regclass('public.d365_reconciliation_runs') IS NULL OR
     NOT has_table_privilege('battle_bus_runtime', 'public.d365_reconciliation_runs', 'INSERT,UPDATE,SELECT') OR
     has_table_privilege('authenticated', 'public.d365_reconciliation_runs', 'SELECT') OR
     has_table_privilege('anon', 'public.d365_reconciliation_runs', 'INSERT') THEN
    RAISE EXCEPTION 'Direct reconciliation storage or privilege contract failed';
  END IF;
END $$;
