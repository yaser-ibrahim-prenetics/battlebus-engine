CREATE TABLE public.backorder_recovery_leases (
  shopify_store text NOT NULL
    CHECK (length(btrim(shopify_store)) BETWEEN 1 AND 255),
  order_id text NOT NULL
    CHECK (length(btrim(order_id)) BETWEEN 1 AND 255),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_operation_key text NOT NULL
    CHECK (length(btrim(last_operation_key)) BETWEEN 1 AND 1024),
  last_lease_owner text NOT NULL
    CHECK (length(btrim(last_lease_owner)) BETWEEN 1 AND 255),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shopify_store, order_id),
  CONSTRAINT backorder_recovery_leases_state
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT backorder_recovery_leases_expiry
    CHECK (lease_expires_at IS NULL OR lease_expires_at > acquired_at)
);

COMMENT ON TABLE public.backorder_recovery_leases IS
  'Cross-worker order leases that prevent concurrent automatic and manual backorder recovery attempts.';
COMMENT ON COLUMN public.backorder_recovery_leases.last_operation_key IS
  'Stable retry operation identifier retained for support evidence after the active lease is released.';

ALTER TABLE public.backorder_recovery_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backorder_recovery_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.backorder_recovery_leases TO battle_bus_runtime;
CREATE POLICY backorder_recovery_leases_runtime
  ON public.backorder_recovery_leases FOR ALL TO battle_bus_runtime
  USING (true) WITH CHECK (true);
