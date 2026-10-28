DO $$
BEGIN
  IF NOT has_table_privilege('battle_bus_runtime','public.reconciliation_attempts','SELECT,INSERT,UPDATE') OR
     has_table_privilege('authenticated','public.reconciliation_attempts','SELECT') OR
     NOT has_table_privilege('battle_bus_runtime','public.workflow_observations','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'Operational history privilege contract failed';
  END IF;
END $$;
