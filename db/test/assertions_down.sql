DO $$
DECLARE
  remaining_tables text[];
BEGIN
  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO remaining_tables
  FROM unnest(ARRAY[
    'refund_hold_decisions', 'audit_entities', 'audit_log', 'backorder_recovery_leases', 'channel_lift_run_attempts', 'channel_lift_runs', 'flow_logs', 'inventory', 'locations',
    'fulfillment_evidence_claims', 'mission_runs', 'order_lines', 'order_segment_refunds',
    'oos_drain_command_receipts', 'oos_drain_requests', 'oos_recovery_dependencies', 'oos_recovery_mutation_leases', 'oos_recovery_outbox',
    'openai_ads_conversions', 'openai_ads_replay_requests', 'orders', 'pending_lifecycle_action_resolutions', 'pending_lifecycle_actions', 'provider_capacity_leases',
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

  IF to_regclass('public.battle_hub_oos_recovery') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left Battle Hub OOS recovery view behind';
  END IF;

  IF to_regclass('public.battle_hub_openai_ads_conversions') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left Battle Hub OpenAI Ads view behind';
  END IF;

  IF to_regclass('public.battle_hub_channel_lift_runs') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left Battle Hub channel-lift view behind';
  END IF;

  IF to_regclass('public.battle_hub_channel_lift_run_attempts') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left Battle Hub channel-lift attempt view behind';
  END IF;

  IF to_regprocedure('public.battle_platform_scrub_pending_action_payload()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left pending-action scrub function behind';
  END IF;

  IF to_regprocedure('public.battle_platform_enforce_channel_lift_transition()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left channel-lift transition guard behind';
  END IF;

  IF to_regprocedure('public.requeue_pending_lifecycle_action(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left pending-action replay function behind';
  END IF;

  IF to_regprocedure('public.pending_lifecycle_action_rollback_status()') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback left pending-action rollback gate behind';
  END IF;

  IF to_regprocedure('public.discard_dead_letter_pending_lifecycle_action(uuid,text)') IS NOT NULL
    OR to_regprocedure('public.battle_platform_enforce_pending_action_transition()') IS NOT NULL
    OR to_regclass('public.pending_lifecycle_action_discards') IS NOT NULL
  THEN
    RAISE EXCEPTION 'Rollback left pending-action hardening functions behind';
  END IF;
END
$$;
