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
      'battle_bus_runtime', 'public.channel_lift_runs', 'SELECT,INSERT'
    )
    OR NOT has_column_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'status', 'UPDATE'
    )
    OR has_column_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'request_reason', 'UPDATE'
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

  IF to_regprocedure('public.battle_platform_enforce_channel_lift_transition()') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'public.channel_lift_runs'::regclass
        AND tgname = 'battle_platform_enforce_channel_lift_transition'
        AND NOT tgisinternal
    )
  THEN
    RAISE EXCEPTION 'Channel-lift transition guard is missing';
  END IF;
END
$$;
