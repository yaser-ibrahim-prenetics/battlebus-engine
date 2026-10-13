DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'pending_actions'
  ) THEN
    RAISE EXCEPTION 'orders.pending_actions is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'locations'
      AND column_name = 'country_data_area_mapping'
  ) THEN
    RAISE EXCEPTION 'locations.country_data_area_mapping is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND 'anon' = ANY(roles)
      AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'Anonymous write policy detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema = 'public'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Anonymous table write grant detected';
  END IF;

  IF has_table_privilege('authenticated', 'public.webhook_inbox', 'SELECT')
    OR has_table_privilege('authenticated', 'public.audit_log', 'SELECT')
    OR has_table_privilege('authenticated', 'public.pending_lifecycle_actions', 'SELECT')
    OR has_table_privilege('authenticated', 'public.refund_operations', 'SELECT')
    OR has_table_privilege('authenticated', 'public.battle_hub_pending_lifecycle_actions', 'SELECT')
    OR has_table_privilege('authenticated', 'public.battle_hub_refund_operations', 'SELECT')
  THEN
    RAISE EXCEPTION 'Sensitive backend tables are exposed to authenticated clients';
  END IF;

  IF to_regprocedure('public.search_orders(text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'search_orders RPC is missing';
  END IF;

  IF to_regprocedure('public.get_order_directory_stats()') IS NULL THEN
    RAISE EXCEPTION 'get_order_directory_stats RPC is missing';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.pending_lifecycle_actions', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private lifecycle action table';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_pending_lifecycle_actions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read the safe pending-action view';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_refund_operations',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read the safe refund-operation view';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.refund_operations', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private refund operation table';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.pending_lifecycle_actions', 'INSERT')
    OR has_table_privilege('battle_hub_runtime', 'public.pending_lifecycle_actions', 'UPDATE')
    OR has_table_privilege('battle_hub_runtime', 'public.pending_lifecycle_actions', 'DELETE')
  THEN
    RAISE EXCEPTION 'Battle Hub runtime unexpectedly has write access to pending lifecycle actions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'battle_hub_pending_lifecycle_actions'
      AND column_name = 'event_data'
  ) THEN
    RAISE EXCEPTION 'Battle Hub pending-action view exposes event_data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'battle_hub_refund_operations'
      AND column_name = 'event_data'
  ) THEN
    RAISE EXCEPTION 'Battle Hub refund-operation view exposes event_data';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users AS u
    JOIN public.roles AS r ON r.id = u.role_id
    JOIN public.workspace_members AS wm ON wm.user_id = u.id
    JOIN public.workspaces AS w ON w.id = wm.workspace_id
    WHERE u.email = 'migration-admin@example.com'
      AND u.status = 'active'
      AND r.name = 'superadmin'
      AND wm.status = 'active'
      AND w.slug = 'battle-hub'
  ) THEN
    RAISE EXCEPTION 'Superadmin bootstrap did not create an active workspace member';
  END IF;
END
$$;
