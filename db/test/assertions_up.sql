BEGIN;

DO $$
DECLARE
  missing_tables text[];
  table_name text;
  rls_enabled boolean;
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'audit_entities', 'audit_log', 'backorder_recovery_leases', 'flow_logs', 'inventory', 'locations',
    'mission_runs', 'oos_recovery_mutation_leases', 'order_lines', 'orders', 'pending_lifecycle_action_discards',
    'pending_lifecycle_action_resolutions', 'pending_lifecycle_actions', 'permissions', 'products',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks',
    'user_permissions', 'user_preferences', 'users', 'webhook_inbox',
    'workspace_members', 'workspaces'
  ]) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Missing expected tables: %', missing_tables;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'audit_entities', 'audit_log', 'backorder_recovery_leases', 'flow_logs', 'inventory', 'locations',
    'mission_runs', 'oos_recovery_mutation_leases', 'order_lines', 'orders', 'pending_lifecycle_action_discards',
    'pending_lifecycle_action_resolutions', 'pending_lifecycle_actions', 'permissions', 'products',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks',
    'user_permissions', 'user_preferences', 'users', 'webhook_inbox',
    'workspace_members', 'workspaces'
  ]
  LOOP
    SELECT c.relrowsecurity
    INTO rls_enabled
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = table_name;

    IF rls_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not enabled on public.%', table_name;
    END IF;
  END LOOP;
END
$$;

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
  THEN
    RAISE EXCEPTION 'Sensitive backend tables are exposed to authenticated clients';
  END IF;

  IF to_regprocedure('public.search_orders(text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'search_orders RPC is missing';
  END IF;

  IF to_regprocedure('public.get_order_directory_stats()') IS NULL THEN
    RAISE EXCEPTION 'get_order_directory_stats RPC is missing';
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

INSERT INTO public.users (email, auth_id, role_id, status)
SELECT
  'migration-test@example.com',
  '00000000-0000-0000-0000-000000000001',
  r.id,
  'active'
FROM public.roles AS r
WHERE r.name = 'operations';

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","email":"migration-test@example.com"}',
  true
);

SET LOCAL ROLE authenticated;

DO $$
BEGIN
  IF public.battle_platform_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authenticated user lookup failed';
  END IF;

  IF NOT public.battle_platform_has_permission('read', 'orders') THEN
    RAISE EXCEPTION 'Operations user should be able to read orders';
  END IF;

  IF public.battle_platform_has_permission('manage', 'users') THEN
    RAISE EXCEPTION 'Operations user must not manage users';
  END IF;

  BEGIN
    UPDATE public.users
    SET role_id = (SELECT id FROM public.roles WHERE name = 'superadmin')
    WHERE id = public.battle_platform_current_user_id();
    RAISE EXCEPTION 'Self-service role escalation unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$$;

SELECT count(*) FROM public.orders;
SELECT count(*) FROM public.inventory;

ROLLBACK;

\ir assertions_up/001_fulfillment_actions.sql
\ir assertions_up/002_direct_reconciliation.sql
\ir assertions_up/003_refund_hold_storage.sql
\ir assertions_up/004_refund_hold_access.sql
\ir assertions_up/005_order_segment_storage.sql
\ir assertions_up/006_order_segment_access.sql
\ir assertions_up/007_operational_history.sql
\ir assertions_up/008_refund_allocation.sql
\ir assertions_up/009_recovery_audit.sql
\ir assertions_up/010_pending_lifecycle_actions.sql
\ir assertions_up/011_backorder_recovery_leases.sql
\ir assertions_up/012_webhook_inbox_delivery.sql
\ir assertions_up/013_oos_recovery_queue.sql
\ir assertions_up/014_provider_capacity.sql
