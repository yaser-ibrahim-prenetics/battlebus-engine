BEGIN;

CREATE FUNCTION public.battle_platform_capture_outbox_timeline()
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
    error_class,
    recovery_action,
    metadata,
    occurred_at
  )
  VALUES (
    concat('outbox:', NEW.id::text, ':', NEW.state, ':', NEW.attempts::text),
    NEW.shopify_order_id,
    NEW.shopify_order_name,
    NEW.source,
    'outbox',
    NEW.event_name,
    NEW.state,
    NEW.last_error,
    NEW.error_class,
    NEW.recovery_action,
    jsonb_build_object(
      'outboxId', NEW.id,
      'eventId', NEW.event_id,
      'attempts', NEW.attempts,
      'schemaVersion', NEW.schema_version
    ),
    now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_event_outbox_timeline
  AFTER INSERT OR UPDATE OF state, attempts, last_error ON public.event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_capture_outbox_timeline();

COMMIT;
