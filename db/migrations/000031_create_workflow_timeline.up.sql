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

COMMIT;
