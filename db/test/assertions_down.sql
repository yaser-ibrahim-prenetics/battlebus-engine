DO $$
DECLARE
  remaining_tables text[];
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO remaining_tables
  FROM unnest(ARRAY[
    'audit_entities', 'audit_log', 'battle_hub_openai_ads_conversions', 'battle_hub_pending_lifecycle_actions', 'battle_hub_reconciliation_history', 'battle_hub_refund_operations', 'battle_hub_workflow_timeline', 'event_outbox', 'flow_logs', 'inventory', 'locations',
    'mission_runs', 'order_lines', 'orders', 'pending_lifecycle_actions', 'permissions', 'products',
    'openai_ads_conversions', 'reconciliation_history', 'refund_operations',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks',
    'user_permissions', 'user_preferences', 'users', 'webhook_inbox', 'workflow_timeline_events',
    'workspace_members', 'workspaces', 'cutover_evidence', 'workflow_run_health'
  ]) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NOT NULL;

  IF remaining_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left application tables behind: %', remaining_tables;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regprocedure('public.battle_platform_scrub_pending_action_payload()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left the pending-action payload scrubber behind';
  END IF;

  IF to_regprocedure('public.battle_platform_scrub_refund_operation_payload()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left the refund-operation payload scrubber behind';
  END IF;

END
$$;
