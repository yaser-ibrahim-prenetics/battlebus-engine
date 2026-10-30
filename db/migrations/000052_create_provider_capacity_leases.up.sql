BEGIN;

CREATE TABLE public.provider_capacity_leases (
  provider text NOT NULL,
  slot smallint NOT NULL,
  lease_token uuid,
  lease_owner uuid,
  operation_digest text,
  leased_at timestamptz,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, slot),
  CONSTRAINT provider_capacity_provider_valid CHECK (
    provider IN ('d365', 'gps', 'shopify', 'stord', 'loop')
  ),
  CONSTRAINT provider_capacity_slot_valid CHECK (slot BETWEEN 1 AND 100),
  CONSTRAINT provider_capacity_operation_digest_shape CHECK (
    operation_digest IS NULL OR operation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT provider_capacity_lease_shape CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND operation_digest IS NULL
      AND leased_at IS NULL AND lease_until IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND operation_digest IS NOT NULL
      AND leased_at IS NOT NULL AND lease_until > leased_at)
  )
);

INSERT INTO public.provider_capacity_leases (provider, slot)
SELECT provider, slot
FROM unnest(ARRAY['d365', 'gps', 'shopify', 'stord', 'loop']) AS providers(provider)
CROSS JOIN generate_series(1, 100) AS slots(slot);

CREATE INDEX idx_provider_capacity_expiry
  ON public.provider_capacity_leases (provider, lease_until, slot)
  WHERE lease_token IS NOT NULL;

CREATE TRIGGER battle_platform_provider_capacity_updated_at
  BEFORE UPDATE ON public.provider_capacity_leases
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.provider_capacity_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_capacity_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.provider_capacity_leases TO battle_bus_runtime;
CREATE POLICY provider_capacity_runtime ON public.provider_capacity_leases
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

COMMENT ON TABLE public.provider_capacity_leases IS
  'Cross-instance provider capacity slots containing only opaque lease ownership and operation digests.';

COMMIT;
