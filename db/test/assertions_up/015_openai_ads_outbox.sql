DO $$
DECLARE
  rls_enabled boolean;
BEGIN
  IF to_regclass('public.openai_ads_conversions') IS NULL
    OR to_regclass('public.idx_openai_ads_conversions_due') IS NULL
    OR to_regclass('public.idx_openai_ads_conversions_expired_lease') IS NULL
    OR to_regclass('public.battle_hub_openai_ads_conversions') IS NULL
  THEN
    RAISE EXCEPTION 'OpenAI Ads outbox schema is incomplete';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.openai_ads_conversions'::regclass;

  IF rls_enabled IS DISTINCT FROM true
    OR NOT has_table_privilege(
      'battle_bus_runtime', 'public.openai_ads_conversions', 'SELECT,INSERT,UPDATE'
    )
    OR has_table_privilege(
      'battle_bus_runtime', 'public.openai_ads_conversions', 'DELETE,TRUNCATE'
    )
    OR has_table_privilege('anon', 'public.openai_ads_conversions', 'SELECT')
    OR has_table_privilege('authenticated', 'public.openai_ads_conversions', 'SELECT')
    OR NOT has_table_privilege(
      'battle_hub_runtime', 'public.battle_hub_openai_ads_conversions', 'SELECT'
    )
    OR has_table_privilege(
      'battle_hub_runtime', 'public.openai_ads_conversions', 'SELECT'
    )
  THEN
    RAISE EXCEPTION 'OpenAI Ads outbox privilege contract failed';
  END IF;
END
$$;
