DO $$
BEGIN
  IF to_regclass('public.oos_recovery_dependencies') IS NULL
    OR to_regclass('public.oos_drain_requests') IS NULL
    OR to_regclass('public.oos_drain_command_receipts') IS NULL
    OR to_regclass('public.oos_recovery_outbox') IS NULL
    OR to_regclass('public.oos_recovery_mutation_leases') IS NULL
    OR to_regclass('public.battle_hub_oos_recovery') IS NULL
  THEN
    RAISE EXCEPTION 'OOS recovery schema is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'oos_drain_command_receipts'
      AND column_name = 'preview_token' AND data_type = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'oos_drain_command_receipts'
      AND column_name = 'preview_started_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'OOS preview execution lease columns are missing';
  END IF;

  IF to_regclass('public.idx_oos_dependency_active_identity') IS NULL
    OR to_regclass('public.idx_oos_dependency_inventory_fifo') IS NULL
    OR to_regclass('public.idx_oos_dependency_ready') IS NULL
    OR to_regclass('public.idx_oos_dependency_expiry') IS NULL
    OR to_regclass('public.idx_oos_drain_open_slot') IS NULL
    OR to_regclass('public.idx_oos_outbox_ready') IS NULL
    OR to_regclass('public.idx_oos_recovery_mutation_operation') IS NULL
    OR to_regclass('public.idx_oos_recovery_mutation_order') IS NULL
  THEN
    RAISE EXCEPTION 'OOS recovery indexes are incomplete';
  END IF;

  IF NOT has_table_privilege('battle_bus_runtime', 'public.oos_recovery_dependencies', 'SELECT,INSERT,UPDATE')
    OR has_table_privilege('battle_bus_runtime', 'public.oos_recovery_dependencies', 'DELETE,TRUNCATE')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.oos_drain_requests', 'SELECT,INSERT,UPDATE')
    OR has_table_privilege('battle_bus_runtime', 'public.oos_drain_requests', 'DELETE,TRUNCATE')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.oos_drain_command_receipts', 'SELECT,INSERT')
    OR NOT has_column_privilege('battle_bus_runtime', 'public.oos_drain_command_receipts', 'preview_token', 'UPDATE')
    OR NOT has_column_privilege('battle_bus_runtime', 'public.oos_drain_command_receipts', 'preview_started_at', 'UPDATE')
    OR has_table_privilege('battle_bus_runtime', 'public.oos_drain_command_receipts', 'DELETE,TRUNCATE')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.oos_recovery_outbox', 'SELECT,INSERT,UPDATE')
    OR has_table_privilege('battle_bus_runtime', 'public.oos_recovery_outbox', 'DELETE,TRUNCATE')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.oos_recovery_mutation_leases', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('battle_bus_runtime', 'public.oos_recovery_mutation_leases', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'OOS runtime privilege contract failed';
  END IF;

  IF has_table_privilege('anon', 'public.oos_recovery_dependencies', 'SELECT')
    OR has_table_privilege('authenticated', 'public.oos_recovery_dependencies', 'SELECT')
    OR has_table_privilege('anon', 'public.oos_recovery_outbox', 'SELECT')
    OR has_table_privilege('authenticated', 'public.oos_recovery_outbox', 'SELECT')
    OR has_table_privilege('anon', 'public.oos_drain_command_receipts', 'SELECT')
    OR has_table_privilege('authenticated', 'public.oos_drain_command_receipts', 'SELECT')
    OR has_table_privilege('anon', 'public.oos_recovery_mutation_leases', 'SELECT')
    OR has_table_privilege('authenticated', 'public.oos_recovery_mutation_leases', 'SELECT')
  THEN
    RAISE EXCEPTION 'OOS recovery data is exposed to client roles';
  END IF;

  IF NOT has_table_privilege('battle_hub_runtime', 'public.battle_hub_oos_recovery', 'SELECT')
    OR has_table_privilege('battle_hub_runtime', 'public.oos_recovery_dependencies', 'SELECT')
    OR has_table_privilege('battle_hub_runtime', 'public.oos_recovery_outbox', 'SELECT')
    OR has_table_privilege('battle_hub_runtime', 'public.oos_recovery_mutation_leases', 'SELECT')
  THEN
    RAISE EXCEPTION 'Battle Hub OOS visibility is not restricted to the safe view';
  END IF;
END
$$;
