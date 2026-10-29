BEGIN;

CREATE TABLE public.oos_recovery_mutation_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_store text NOT NULL,
  order_id text NOT NULL,
  replay_token uuid NOT NULL,
  operation_key text NOT NULL,
  request_fingerprint text NOT NULL,
  lease_owner text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  lease_until timestamptz,
  finished_at timestamptz,
  result_payload jsonb,
  failure_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oos_mutation_operation_key_shape CHECK (operation_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oos_mutation_request_fingerprint_shape CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT oos_mutation_lease_owner_nonempty CHECK (length(trim(lease_owner)) > 0),
  CONSTRAINT oos_mutation_state_valid CHECK (
    state IN ('pending', 'accepted', 'rejected', 'uncertain')
  ),
  CONSTRAINT oos_mutation_state_shape CHECK (
    (state = 'pending' AND lease_until > created_at AND finished_at IS NULL
      AND result_payload IS NULL AND failure_payload IS NULL)
    OR (state = 'accepted' AND lease_until IS NULL AND finished_at IS NOT NULL
      AND result_payload IS NOT NULL AND failure_payload IS NULL)
    OR (state = 'rejected' AND lease_until IS NULL AND finished_at IS NOT NULL
      AND result_payload IS NULL AND failure_payload IS NOT NULL)
    OR (state = 'uncertain' AND lease_until IS NULL AND finished_at IS NOT NULL
      AND result_payload IS NULL AND failure_payload IS NULL)
  ),
  CONSTRAINT oos_mutation_result_size CHECK (
    result_payload IS NULL OR octet_length(result_payload::text) <= 4096
  ),
  CONSTRAINT oos_mutation_failure_size CHECK (
    failure_payload IS NULL OR octet_length(failure_payload::text) <= 65536
  )
);

CREATE UNIQUE INDEX idx_oos_recovery_mutation_operation
  ON public.oos_recovery_mutation_leases (
    lower(shopify_store), order_id, replay_token, operation_key
  );
CREATE INDEX idx_oos_recovery_mutation_order
  ON public.oos_recovery_mutation_leases (lower(shopify_store), order_id, lease_until);
CREATE INDEX idx_oos_recovery_mutation_cleanup
  ON public.oos_recovery_mutation_leases (created_at, id);

ALTER TABLE public.oos_recovery_mutation_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.oos_recovery_mutation_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oos_recovery_mutation_leases TO battle_bus_runtime;
CREATE POLICY oos_mutation_leases_runtime ON public.oos_recovery_mutation_leases
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

COMMENT ON TABLE public.oos_recovery_mutation_leases IS
  'Durable operation records fencing exact replay attempts while they mutate external providers.';

COMMIT;
