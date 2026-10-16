DO $$
DECLARE
  missing_tables text[];
  table_name text;
  rls_enabled boolean;
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'audit_entities', 'audit_log', 'event_outbox', 'flow_logs', 'inventory', 'locations',
    'mission_runs', 'order_lines', 'orders', 'pending_lifecycle_actions', 'permissions', 'products',
    'refund_operations',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks',
    'user_permissions', 'user_preferences', 'users', 'webhook_inbox', 'workflow_timeline_events',
    'workspace_members', 'workspaces'
  ]) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Missing expected tables: %', missing_tables;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'audit_entities', 'audit_log', 'event_outbox', 'flow_logs', 'inventory', 'locations',
    'mission_runs', 'order_lines', 'orders', 'pending_lifecycle_actions', 'permissions', 'products',
    'refund_operations',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks',
    'user_permissions', 'user_preferences', 'users', 'webhook_inbox', 'workflow_timeline_events',
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
