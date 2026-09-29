BEGIN;

CREATE TABLE IF NOT EXISTS public.refund_operations (
  refund_id text PRIMARY KEY,
  shopify_order_id text NOT NULL,
  event_name text NOT NULL DEFAULT 'shopify/refund.created',
  event_data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'processing',
  attempts integer NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  d365_order_number text,
  inventory_lot_id text,
  last_error text,
  line_created_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_operations_state_valid
    CHECK (state IN ('awaiting_order', 'dispatching', 'processing', 'line_created', 'completed')),
  CONSTRAINT refund_operations_attempts_positive CHECK (attempts > 0),
  CONSTRAINT refund_operations_event_data_object CHECK (jsonb_typeof(event_data) = 'object'),
  CONSTRAINT refund_operations_claim_consistent
    CHECK (
      (
        state IN ('dispatching', 'processing', 'line_created')
        AND claim_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR
      (
        state IN ('awaiting_order', 'completed')
        AND claim_token IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT refund_operations_completed_payload_scrubbed
    CHECK (state <> 'completed' OR event_data = '{}'::jsonb)
);

CREATE INDEX IF NOT EXISTS idx_refund_operations_recovery
  ON public.refund_operations (available_at, created_at)
  WHERE state = 'awaiting_order';
CREATE INDEX IF NOT EXISTS idx_refund_operations_expired_dispatch
  ON public.refund_operations (lease_expires_at)
  WHERE state = 'dispatching';
CREATE INDEX IF NOT EXISTS idx_refund_operations_shopify_order
  ON public.refund_operations (shopify_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.battle_platform_scrub_refund_operation_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state = 'completed' THEN
    NEW.event_data := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS battle_platform_scrub_refund_operation_payload
  ON public.refund_operations;
CREATE TRIGGER battle_platform_scrub_refund_operation_payload
  BEFORE INSERT OR UPDATE ON public.refund_operations
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_scrub_refund_operation_payload();

DROP TRIGGER IF EXISTS battle_platform_refund_operations_updated_at
  ON public.refund_operations;
CREATE TRIGGER battle_platform_refund_operations_updated_at
  BEFORE UPDATE ON public.refund_operations
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.refund_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.refund_operations FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.refund_operations TO service_role;

CREATE POLICY refund_operations_service_role_all
  ON public.refund_operations
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.refund_operations IS
  'Database-enforced refund deduplication and recovery ledger keyed by Shopify refund ID.';
COMMENT ON COLUMN public.refund_operations.event_data IS
  'Retained only while a refund is active and scrubbed when processing completes.';
COMMENT ON COLUMN public.refund_operations.state IS
  'awaiting_order is recoverable; dispatching is leased; processing and line_created are owned by one Inngest run.';

COMMIT;
