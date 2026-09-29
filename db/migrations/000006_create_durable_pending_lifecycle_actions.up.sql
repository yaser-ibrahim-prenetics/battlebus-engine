BEGIN;

CREATE TABLE IF NOT EXISTS public.pending_lifecycle_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL,
  shopify_order_name text,
  action text NOT NULL,
  event_name text NOT NULL,
  event_data jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_lifecycle_actions_action_valid
    CHECK (action IN ('fulfill', 'cancel', 'refund')),
  CONSTRAINT pending_lifecycle_actions_status_valid
    CHECK (status IN ('pending', 'processing', 'published', 'superseded')),
  CONSTRAINT pending_lifecycle_actions_attempts_nonnegative
    CHECK (attempts >= 0),
  CONSTRAINT pending_lifecycle_actions_event_data_object
    CHECK (jsonb_typeof(event_data) = 'object'),
  CONSTRAINT pending_lifecycle_actions_claim_consistent
    CHECK (
      (status = 'processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'processing' AND claim_token IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_pending_lifecycle_actions_ready
  ON public.pending_lifecycle_actions (available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_lifecycle_actions_expired_lease
  ON public.pending_lifecycle_actions (lease_expires_at)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_pending_lifecycle_actions_order
  ON public.pending_lifecycle_actions (shopify_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_lifecycle_actions_status_created
  ON public.pending_lifecycle_actions (status, created_at DESC);

DROP TRIGGER IF EXISTS battle_platform_pending_lifecycle_actions_updated_at
  ON public.pending_lifecycle_actions;
CREATE TRIGGER battle_platform_pending_lifecycle_actions_updated_at
  BEFORE UPDATE ON public.pending_lifecycle_actions
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.pending_lifecycle_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pending_lifecycle_actions FROM anon, authenticated;
GRANT ALL ON TABLE public.pending_lifecycle_actions TO service_role;

CREATE POLICY pending_lifecycle_actions_service_role_all
  ON public.pending_lifecycle_actions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.pending_lifecycle_actions IS
  'Durable out-of-order lifecycle actions owned and replayed by Battle Bus; visible read-only to Battle Hub.';
COMMENT ON COLUMN public.pending_lifecycle_actions.idempotency_key IS
  'Stable digest of the source order, event name, action type, and event payload.';
COMMENT ON COLUMN public.pending_lifecycle_actions.lease_expires_at IS
  'Expired processing leases can be reclaimed safely because replayed Inngest events use stable IDs.';

COMMIT;
