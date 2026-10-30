BEGIN;
SET LOCAL ROLE battle_bus_runtime;
INSERT INTO public.flow_logs (flow, shopify_order_id, error_message, payload)
VALUES ('timeline-test', 'timeline-test-order', 'secret-provider-message', '{"secret":"private"}');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_timeline_events
    WHERE shopify_order_id='timeline-test-order' AND message IS NULL AND error_class IS NULL AND metadata='{}') THEN
    RAISE EXCEPTION 'Safe timeline event missing';
  END IF;
  BEGIN
    UPDATE public.workflow_timeline_events SET status='rewritten';
    RAISE EXCEPTION 'Runtime could rewrite history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.workflow_timeline_events;
    RAISE EXCEPTION 'Runtime could delete history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    TRUNCATE public.workflow_timeline_events;
    RAISE EXCEPTION 'Runtime could truncate history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
DELETE FROM public.flow_logs WHERE shopify_order_id='timeline-test-order';
RESET ROLE;
SET LOCAL ROLE battle_hub_runtime;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.battle_hub_workflow_timeline WHERE shopify_order_id='timeline-test-order') THEN
    RAISE EXCEPTION 'Timeline must survive source log retention';
  END IF;
  BEGIN
    PERFORM * FROM public.workflow_timeline_events;
    RAISE EXCEPTION 'Hub could read base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
  RESET ROLE;
SET LOCAL ROLE battle_hub_runtime;
DO $$ BEGIN
  BEGIN
    INSERT INTO public.battle_hub_workflow_timeline (source,event_type,stage,status)
    VALUES ('unauthorized','workflow','test','failed');
    RAISE EXCEPTION 'Hub could append history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.battle_hub_workflow_timeline SET status='changed';
    RAISE EXCEPTION 'Hub could rewrite history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
