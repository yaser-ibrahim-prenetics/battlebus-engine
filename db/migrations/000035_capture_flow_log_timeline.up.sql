BEGIN;

CREATE FUNCTION public.battle_platform_capture_flow_log_timeline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shopify_order_id IS NULL AND NEW.shopify_order_name IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.workflow_timeline_events (
    idempotency_key,
    shopify_order_id,
    shopify_order_name,
    source,
    event_type,
    stage,
    status,
    message,
    run_id,
    error_class,
    metadata,
    occurred_at
  )
  VALUES (
    concat('flow-log:', NEW.id::text),
    NEW.shopify_order_id,
    NEW.shopify_order_name,
    COALESCE(NEW.client, NEW.flow),
    'workflow',
    COALESCE(NEW.step, NEW.flow),
    COALESCE(NEW.status, NEW.level),
    NEW.error_message,
    NEW.run_id,
    NEW.error_type,
    jsonb_strip_nulls(jsonb_build_object(
      'flow', NEW.flow,
      'durationMs', NEW.duration_ms,
      'requestId', NEW.request_id,
      'd365OrderNumber', NEW.d365_order_number
    )),
    NEW.ts
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_flow_log_timeline
  AFTER INSERT ON public.flow_logs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_capture_flow_log_timeline();

COMMIT;
