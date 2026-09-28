BEGIN;

CREATE TABLE IF NOT EXISTS public.flow_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL DEFAULT 'info',
  flow text NOT NULL,
  step text,
  client text,
  run_id text,
  request_id text,
  shopify_order_id text,
  shopify_order_name text,
  d365_order_number text,
  status text,
  duration_ms integer,
  error_type text,
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT flow_logs_duration_nonnegative
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT flow_logs_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_flow_logs_ts
  ON public.flow_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_flow
  ON public.flow_logs (flow);
CREATE INDEX IF NOT EXISTS idx_flow_logs_level
  ON public.flow_logs (level);
CREATE INDEX IF NOT EXISTS idx_flow_logs_run_id
  ON public.flow_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_id
  ON public.flow_logs (shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_name
  ON public.flow_logs (shopify_order_name);
CREATE INDEX IF NOT EXISTS idx_flow_logs_d365_order_number
  ON public.flow_logs (d365_order_number);
CREATE INDEX IF NOT EXISTS idx_flow_logs_order_ts
  ON public.flow_logs (shopify_order_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_flow_ts_desc
  ON public.flow_logs (flow, ts DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_name_trgm
  ON public.flow_logs USING gin (shopify_order_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_id_trgm
  ON public.flow_logs USING gin (shopify_order_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_run_id_trgm
  ON public.flow_logs USING gin (run_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_d365_order_number_trgm
  ON public.flow_logs USING gin (d365_order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_error_message_trgm
  ON public.flow_logs USING gin (error_message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_payload_shopify_order_name_trgm
  ON public.flow_logs USING gin ((payload->>'shopifyOrderName') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_payload_shopify_order_id_trgm
  ON public.flow_logs USING gin ((payload->>'shopifyOrderId') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_flow_logs_payload_d365_order_number_trgm
  ON public.flow_logs USING gin ((payload->>'d365OrderNumber') gin_trgm_ops);

CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  topic text,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'received',
  event_ids text[],
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  CONSTRAINT webhook_inbox_status_valid
    CHECK (status IN ('received', 'published', 'failed')),
  CONSTRAINT webhook_inbox_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT webhook_inbox_headers_object CHECK (jsonb_typeof(headers) = 'object'),
  CONSTRAINT webhook_inbox_events_array CHECK (jsonb_typeof(events) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status
  ON public.webhook_inbox (status);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_received_at
  ON public.webhook_inbox (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_source
  ON public.webhook_inbox (source);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_unpublished
  ON public.webhook_inbox (received_at ASC)
  WHERE status <> 'published';

CREATE TABLE IF NOT EXISTS public.mission_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id text NOT NULL UNIQUE,
  mission_type text NOT NULL,
  test_run_id text,
  order_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mission_runs_type_valid
    CHECK (mission_type IN ('single', 'bulk', 'mass')),
  CONSTRAINT mission_runs_order_count_nonnegative CHECK (order_count >= 0),
  CONSTRAINT mission_runs_order_names_array CHECK (jsonb_typeof(order_names) = 'array'),
  CONSTRAINT mission_runs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_mission_runs_created_at
  ON public.mission_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_runs_test_run_id
  ON public.mission_runs (test_run_id);

CREATE TABLE IF NOT EXISTS public.audit_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_entities_type_id_unique UNIQUE (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_ref_id uuid REFERENCES public.audit_entities(id) ON DELETE SET NULL,
  user_id text,
  user_email text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  resource_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_audit_entities_ref
  ON public.audit_entities (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id
  ON public.audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON public.audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource
  ON public.audit_log (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_ref
  ON public.audit_log (entity_ref_id);

DROP TRIGGER IF EXISTS battle_platform_mission_runs_updated_at ON public.mission_runs;
CREATE TRIGGER battle_platform_mission_runs_updated_at
  BEFORE UPDATE ON public.mission_runs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'flow_logs', 'webhook_inbox', 'mission_runs', 'audit_entities', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = table_name || '_service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        table_name || '_service_role_all',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE public.webhook_inbox IS
  'Durable webhook receipt recorded after signature validation and before Inngest publication.';
COMMENT ON COLUMN public.webhook_inbox.headers IS
  'Sanitized transport headers only. Authorization, cookies, and signatures must not be stored.';
COMMENT ON TABLE public.flow_logs IS
  'Structured Battle Bus execution events retained for operational diagnostics.';

COMMIT;
