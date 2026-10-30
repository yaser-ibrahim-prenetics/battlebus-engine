DO $$
DECLARE
  rls_enabled boolean;
BEGIN
  IF to_regclass('public.openai_ads_replay_requests') IS NULL
    OR to_regclass('public.idx_openai_ads_replay_event') IS NULL
  THEN
    RAISE EXCEPTION 'OpenAI Ads replay audit schema is incomplete';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.openai_ads_replay_requests'::regclass;

  IF rls_enabled IS DISTINCT FROM true
    OR NOT has_table_privilege(
      'battle_bus_runtime', 'public.openai_ads_replay_requests', 'SELECT,INSERT'
    )
    OR has_table_privilege(
      'battle_bus_runtime', 'public.openai_ads_replay_requests', 'UPDATE,DELETE,TRUNCATE'
    )
    OR NOT has_column_privilege(
      'battle_bus_runtime', 'public.openai_ads_replay_requests', 'status', 'UPDATE'
    )
    OR NOT has_column_privilege(
      'battle_bus_runtime', 'public.openai_ads_replay_requests', 'error_code', 'UPDATE'
    )
    OR NOT has_column_privilege(
      'battle_bus_runtime', 'public.openai_ads_replay_requests', 'completed_at', 'UPDATE'
    )
    OR has_table_privilege('anon', 'public.openai_ads_replay_requests', 'SELECT')
    OR has_table_privilege('authenticated', 'public.openai_ads_replay_requests', 'SELECT')
    OR has_table_privilege('battle_hub_runtime', 'public.openai_ads_replay_requests', 'SELECT')
  THEN
    RAISE EXCEPTION 'OpenAI Ads replay audit privilege contract failed';
  END IF;
END
$$;
