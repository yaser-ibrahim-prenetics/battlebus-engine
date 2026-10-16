DO $$
BEGIN
  IF has_table_privilege('battle_hub_runtime', 'public.event_outbox', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private event outbox';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.workflow_timeline_events', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private timeline table';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_workflow_timeline',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read the workflow timeline view';
  END IF;

  IF (
    SELECT count(*)
    FROM public.battle_hub_workflow_timeline
    WHERE shopify_order_id = '801'
  ) < 4 THEN
    RAISE EXCEPTION 'Battle Hub workflow timeline view does not expose captured events';
  END IF;
END
$$;
