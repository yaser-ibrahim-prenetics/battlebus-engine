BEGIN;

CREATE TABLE public.oos_recovery_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  order_name text NOT NULL,
  order_line_id text NOT NULL,
  shopify_store text NOT NULL,
  provider text NOT NULL,
  warehouse text NOT NULL,
  sku text NOT NULL,
  quantity_needed integer NOT NULL,
  failure_category text NOT NULL,
  status text NOT NULL DEFAULT 'parked',
  d365_order_number text NOT NULL DEFAULT '',
  source_event_name text,
  failure_stage text NOT NULL DEFAULT 'order_creation',
  retry_mode text NOT NULL DEFAULT 'gps_outbound',
  backorder_queue text NOT NULL DEFAULT 'sync',
  first_parked_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  manual_review_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oos_dependency_provider CHECK (provider IN ('gps', 'd365')),
  CONSTRAINT oos_dependency_quantity_positive CHECK (quantity_needed > 0),
  CONSTRAINT oos_dependency_attempts_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT oos_dependency_version_positive CHECK (version > 0),
  CONSTRAINT oos_dependency_status CHECK (
    status IN ('parked', 'leased', 'retrying', 'resolved', 'manual_review')
  ),
  CONSTRAINT oos_dependency_failure_stage CHECK (
    failure_stage IN ('order_creation', 'fulfillment')
  ),
  CONSTRAINT oos_dependency_retry_mode CHECK (
    retry_mode IN ('gps_outbound', 'fulfillment_replay')
  ),
  CONSTRAINT oos_dependency_backorder_queue CHECK (
    backorder_queue IN ('sync', 'fulfilment')
  ),
  CONSTRAINT oos_dependency_expiry_after_park CHECK (expires_at > first_parked_at),
  CONSTRAINT oos_dependency_lease_consistent CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT oos_dependency_terminal_consistent CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL AND manual_review_at IS NULL)
    OR (status = 'manual_review' AND manual_review_at IS NOT NULL AND resolved_at IS NULL)
    OR (status NOT IN ('resolved', 'manual_review') AND resolved_at IS NULL AND manual_review_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_oos_dependency_active_identity
  ON public.oos_recovery_dependencies (
    shopify_store, order_id, order_line_id, provider, warehouse, sku
  )
  WHERE status IN ('parked', 'leased', 'retrying');
CREATE INDEX idx_oos_dependency_inventory_fifo
  ON public.oos_recovery_dependencies (provider, warehouse, sku, first_parked_at, id)
  WHERE status IN ('parked', 'leased');
CREATE INDEX idx_oos_dependency_order
  ON public.oos_recovery_dependencies (shopify_store, order_id, status, first_parked_at);
CREATE INDEX idx_oos_dependency_ready
  ON public.oos_recovery_dependencies (status, next_attempt_at, first_parked_at, id)
  WHERE status = 'parked';
CREATE INDEX idx_oos_dependency_expiry
  ON public.oos_recovery_dependencies (expires_at, id)
  WHERE status IN ('parked', 'leased', 'retrying');
CREATE INDEX idx_oos_dependency_expired_lease
  ON public.oos_recovery_dependencies (lease_until, id)
  WHERE status = 'leased';

CREATE TRIGGER battle_platform_oos_dependency_updated_at
  BEFORE UPDATE ON public.oos_recovery_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

CREATE TABLE public.oos_drain_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_key text NOT NULL,
  slot text NOT NULL,
  mode text NOT NULL,
  dry_run boolean NOT NULL,
  provider text,
  warehouse text,
  sku text,
  order_id text,
  shopify_store text,
  parked_from timestamptz,
  parked_to timestamptz,
  observed_quantity integer,
  observed_at timestamptz,
  source_event_id text,
  requested_by_hash text,
  batch_limit integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  dispatch_count integer NOT NULL DEFAULT 0,
  result_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT oos_drain_slot CHECK (slot IN ('active', 'successor')),
  CONSTRAINT oos_drain_mode CHECK (mode IN ('inventory_event', 'manual', 'sweep')),
  CONSTRAINT oos_drain_provider CHECK (provider IS NULL OR provider IN ('gps', 'd365')),
  CONSTRAINT oos_drain_status CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
  CONSTRAINT oos_drain_batch_limit CHECK (batch_limit BETWEEN 1 AND 1000),
  CONSTRAINT oos_drain_observed_quantity CHECK (
    observed_quantity IS NULL OR observed_quantity >= 0
  ),
  CONSTRAINT oos_drain_attempts_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT oos_drain_dispatches_nonnegative CHECK (dispatch_count >= 0),
  CONSTRAINT oos_drain_lease_consistent CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT oos_drain_completed_consistent CHECK (
    (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'leased') AND completed_at IS NULL)
  ),
  CONSTRAINT oos_drain_target CHECK (
    mode = 'sweep'
    OR order_id IS NOT NULL
    OR (provider IS NOT NULL AND warehouse IS NOT NULL AND sku IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_oos_drain_open_slot
  ON public.oos_drain_requests (lane_key, slot)
  WHERE status IN ('queued', 'leased');
CREATE INDEX idx_oos_drain_ready
  ON public.oos_drain_requests (status, created_at, id)
  WHERE status = 'queued';
CREATE INDEX idx_oos_drain_expired_lease
  ON public.oos_drain_requests (lease_until, id)
  WHERE status = 'leased';

CREATE TRIGGER battle_platform_oos_drain_updated_at
  BEFORE UPDATE ON public.oos_drain_requests
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

CREATE TABLE public.oos_recovery_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE,
  event_name text NOT NULL,
  event_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oos_outbox_event_name CHECK (
    event_name IN ('backorder/created', 'backorder/retry', 'oos/drain.requested')
  ),
  CONSTRAINT oos_outbox_status CHECK (status IN ('queued', 'leased', 'published', 'failed')),
  CONSTRAINT oos_outbox_attempts_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT oos_outbox_lease_consistent CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT oos_outbox_published_consistent CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT oos_outbox_payload_object CHECK (jsonb_typeof(event_data) = 'object'),
  CONSTRAINT oos_outbox_payload_size CHECK (octet_length(event_data::text) <= 32768)
);

CREATE INDEX idx_oos_outbox_ready
  ON public.oos_recovery_outbox (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'failed');
CREATE INDEX idx_oos_outbox_expired_lease
  ON public.oos_recovery_outbox (lease_until, id)
  WHERE status = 'leased';

CREATE TRIGGER battle_platform_oos_outbox_updated_at
  BEFORE UPDATE ON public.oos_recovery_outbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.oos_recovery_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oos_drain_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oos_recovery_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.oos_recovery_dependencies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.oos_drain_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.oos_recovery_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.oos_recovery_dependencies TO battle_bus_runtime;
GRANT SELECT, INSERT, UPDATE ON public.oos_drain_requests TO battle_bus_runtime;
GRANT SELECT, INSERT, UPDATE ON public.oos_recovery_outbox TO battle_bus_runtime;

CREATE POLICY oos_dependencies_runtime ON public.oos_recovery_dependencies
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
CREATE POLICY oos_drain_requests_runtime ON public.oos_drain_requests
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
CREATE POLICY oos_outbox_runtime ON public.oos_recovery_outbox
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

CREATE VIEW public.battle_hub_oos_recovery AS
SELECT
  id,
  order_id,
  order_name,
  provider,
  warehouse,
  sku,
  quantity_needed,
  failure_category,
  status,
  first_parked_at,
  last_attempt_at,
  attempt_count,
  cooldown_until,
  next_attempt_at,
  expires_at,
  manual_review_at,
  last_error_code,
  updated_at
FROM public.oos_recovery_dependencies
WHERE status <> 'resolved';

REVOKE ALL ON public.battle_hub_oos_recovery FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_oos_recovery TO battle_hub_runtime;

COMMENT ON TABLE public.oos_recovery_dependencies IS
  'Per-original-line inventory dependencies used for FIFO, quantity-aware OOS recovery.';
COMMENT ON TABLE public.oos_drain_requests IS
  'Coalesced live and dry-run drain requests; each lane has one active request and one successor.';
COMMENT ON TABLE public.oos_recovery_outbox IS
  'Minimal durable event payloads committed atomically with OOS parking and recovery decisions.';

COMMIT;
