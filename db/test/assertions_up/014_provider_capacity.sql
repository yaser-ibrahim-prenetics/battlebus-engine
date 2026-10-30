DO $$
BEGIN
  IF to_regclass('public.provider_capacity_leases') IS NULL
    OR to_regclass('public.idx_provider_capacity_expiry') IS NULL
  THEN
    RAISE EXCEPTION 'Provider capacity schema is incomplete';
  END IF;

  IF (SELECT count(*) FROM public.provider_capacity_leases) <> 500 THEN
    RAISE EXCEPTION 'Provider capacity slots were not seeded completely';
  END IF;

  IF NOT has_table_privilege('battle_bus_runtime', 'public.provider_capacity_leases', 'SELECT,UPDATE')
    OR has_table_privilege('battle_bus_runtime', 'public.provider_capacity_leases', 'INSERT,DELETE,TRUNCATE')
    OR has_table_privilege('anon', 'public.provider_capacity_leases', 'SELECT')
    OR has_table_privilege('authenticated', 'public.provider_capacity_leases', 'SELECT')
    OR has_table_privilege('battle_hub_runtime', 'public.provider_capacity_leases', 'SELECT')
  THEN
    RAISE EXCEPTION 'Provider capacity privilege contract failed';
  END IF;
END
$$;
