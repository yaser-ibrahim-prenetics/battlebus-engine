DO $$
DECLARE
  rls_enabled boolean;
BEGIN
  IF to_regclass('public.channel_lift_runs') IS NULL
    OR to_regclass('public.idx_channel_lift_one_active_date') IS NULL
    OR to_regclass('public.idx_channel_lift_runs_recent') IS NULL
    OR to_regclass('public.battle_hub_channel_lift_runs') IS NULL
  THEN
    RAISE EXCEPTION 'Channel-lift evidence schema is incomplete';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.channel_lift_runs'::regclass;

  IF rls_enabled IS DISTINCT FROM true
    OR NOT has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'SELECT,INSERT,UPDATE'
    )
    OR has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'DELETE,TRUNCATE'
    )
    OR has_table_privilege('anon', 'public.channel_lift_runs', 'SELECT')
    OR has_table_privilege('authenticated', 'public.channel_lift_runs', 'SELECT')
    OR NOT has_table_privilege(
      'battle_hub_runtime', 'public.battle_hub_channel_lift_runs', 'SELECT'
    )
    OR has_table_privilege('battle_hub_runtime', 'public.channel_lift_runs', 'SELECT')
  THEN
    RAISE EXCEPTION 'Channel-lift evidence privilege contract failed';
  END IF;
END
$$;
