BEGIN;

CREATE TABLE public.workflow_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  shopify_order_id text,
  shopify_order_name text,
  source text NOT NULL,
  event_type text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  message text,
  run_id text,
  error_class text,
  recovery_action text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_timeline_order_present CHECK (
    shopify_order_id IS NOT NULL OR shopify_order_name IS NOT NULL
  ),
  CONSTRAINT workflow_timeline_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.workflow_timeline_events IS
  'Append-only, idempotent per-order workflow history derived from durable delivery and execution state.';


CREATE INDEX idx_workflow_timeline_order_id
  ON public.workflow_timeline_events (shopify_order_id, occurred_at, id);
CREATE INDEX idx_workflow_timeline_order_name
  ON public.workflow_timeline_events (shopify_order_name, occurred_at, id);
ALTER TABLE public.workflow_timeline_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_timeline_events FROM PUBLIC, anon, authenticated, service_role, battle_bus_runtime, battle_hub_runtime;
GRANT SELECT, INSERT ON public.workflow_timeline_events TO battle_bus_runtime;
CREATE POLICY workflow_timeline_runtime ON public.workflow_timeline_events
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

-- Runs in the inserting role: runtime retains no history mutation privileges.
-- Capture only structured correlation fields; never copy payload or provider messages.
CREATE FUNCTION public.capture_workflow_timeline() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.shopify_order_id IS NOT NULL OR NEW.shopify_order_name IS NOT NULL THEN
    INSERT INTO public.workflow_timeline_events (
      idempotency_key, shopify_order_id, shopify_order_name, source, event_type,
      stage, status, run_id, metadata, occurred_at
    ) VALUES (
      'flow-log:' || NEW.id::text, NEW.shopify_order_id, NEW.shopify_order_name,
      COALESCE(NEW.client, NEW.flow), 'workflow', COALESCE(NEW.step, NEW.flow),
      COALESCE(NEW.status, NEW.level), NEW.run_id,
      jsonb_strip_nulls(jsonb_build_object('durationMs', NEW.duration_ms)), NEW.ts
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.capture_workflow_timeline() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_workflow_timeline() TO battle_bus_runtime;
CREATE TRIGGER capture_workflow_timeline AFTER INSERT ON public.flow_logs
  FOR EACH ROW EXECUTE FUNCTION public.capture_workflow_timeline();

CREATE VIEW public.battle_hub_workflow_timeline WITH (security_barrier = true) AS
SELECT id, shopify_order_id, shopify_order_name, source, event_type, stage, status,
  run_id, metadata, occurred_at
FROM public.workflow_timeline_events;
REVOKE ALL ON public.battle_hub_workflow_timeline FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_workflow_timeline TO battle_hub_runtime;
COMMIT;
