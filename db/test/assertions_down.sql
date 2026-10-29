DO $$
DECLARE
  remaining_tables text[];
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO remaining_tables
  FROM unnest(ARRAY[
    'refund_hold_decisions', 'audit_entities', 'audit_log', 'flow_logs', 'inventory', 'locations',
    'fulfillment_evidence_claims', 'mission_runs', 'order_lines', 'order_segment_refunds',
    'orders', 'pending_lifecycle_action_resolutions', 'pending_lifecycle_actions',
    'permissions', 'products', 'reconciliation_attempts', 'recovery_commands',
    'roles', 'sku_mapping_audit_log', 'sku_mappings', 'stocks', 'user_permissions',
    'user_preferences', 'users', 'webhook_inbox', 'workflow_observations',
    'workspace_members', 'workspaces'
  ]) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NOT NULL;

  IF remaining_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left application tables behind: %', remaining_tables;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.battle_hub_pending_lifecycle_actions') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left Battle Hub pending-action view behind';
  END IF;

  IF to_regprocedure('public.battle_platform_scrub_pending_action_payload()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left pending-action scrub function behind';
  END IF;

  IF to_regprocedure('public.requeue_pending_lifecycle_action(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left pending-action replay function behind';
  END IF;
END
$$;
