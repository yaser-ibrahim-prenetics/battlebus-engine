BEGIN;

CREATE TABLE public.event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES public.webhook_inbox(id) ON DELETE CASCADE,
  source text NOT NULL,
  topic text,
  schema_version text NOT NULL,
  event_name text NOT NULL,
  event_id text,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  shopify_order_id text,
  shopify_order_name text,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  error_class text,
  recovery_action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  dead_lettered_at timestamptz,
  CONSTRAINT event_outbox_state_valid
    CHECK (state IN ('pending', 'processing', 'published', 'dead_letter')),
  CONSTRAINT event_outbox_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT event_outbox_event_data_object CHECK (jsonb_typeof(event_data) = 'object'),
  CONSTRAINT event_outbox_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT event_outbox_claim_consistent CHECK (
    (state = 'processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'processing' AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT event_outbox_published_consistent
    CHECK ((state = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT event_outbox_dead_letter_consistent
    CHECK ((state = 'dead_letter') = (dead_lettered_at IS NOT NULL))
);

CREATE INDEX idx_event_outbox_due
  ON public.event_outbox (available_at, created_at)
  WHERE state = 'pending';
CREATE INDEX idx_event_outbox_expired_lease
  ON public.event_outbox (lease_expires_at)
  WHERE state = 'processing';
CREATE INDEX idx_event_outbox_inbox
  ON public.event_outbox (inbox_id, state);
CREATE INDEX idx_event_outbox_order
  ON public.event_outbox (shopify_order_id, created_at DESC);
CREATE INDEX idx_event_outbox_dead_letter
  ON public.event_outbox (dead_lettered_at DESC)
  WHERE state = 'dead_letter';

CREATE TRIGGER battle_platform_event_outbox_updated_at
  BEFORE UPDATE ON public.event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_outbox FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.event_outbox TO service_role;

CREATE POLICY event_outbox_service_role_all
  ON public.event_outbox
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.event_outbox IS
  'Durable event-delivery queue separated from webhook receipt, with leases, retries, and terminal dead letters.';

COMMIT;
