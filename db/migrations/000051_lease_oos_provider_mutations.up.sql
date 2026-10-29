BEGIN;

CREATE TABLE public.oos_recovery_mutation_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_store text NOT NULL,
  order_id text NOT NULL,
  replay_token uuid NOT NULL,
  lease_owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oos_mutation_lease_owner_nonempty CHECK (length(trim(lease_owner)) > 0),
  CONSTRAINT oos_mutation_lease_future CHECK (lease_until > created_at)
);

CREATE INDEX idx_oos_recovery_mutation_order
  ON public.oos_recovery_mutation_leases (shopify_store, order_id, lease_until);

ALTER TABLE public.oos_recovery_mutation_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.oos_recovery_mutation_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.oos_recovery_mutation_leases TO battle_bus_runtime;
CREATE POLICY oos_mutation_leases_runtime ON public.oos_recovery_mutation_leases
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

COMMENT ON TABLE public.oos_recovery_mutation_leases IS
  'Short-lived claims fencing exact replay attempts while they mutate external providers.';

COMMIT;
