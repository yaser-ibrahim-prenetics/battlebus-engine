BEGIN;

CREATE TABLE IF NOT EXISTS public.openai_ads_conversions (
  event_id text PRIMARY KEY,
  shopify_order_id text NOT NULL,
  shopify_order_name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT openai_ads_conversions_state_valid
    CHECK (state IN ('pending', 'delivering', 'delivered', 'dead_letter')),
  CONSTRAINT openai_ads_conversions_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT openai_ads_conversions_claim_consistent
    CHECK (
      (state = 'delivering' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (state <> 'delivering' AND claim_token IS NULL AND lease_expires_at IS NULL)
    ),
  CONSTRAINT openai_ads_conversions_delivered_consistent
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT openai_ads_conversions_dead_letter_consistent
    CHECK ((state = 'dead_letter') = (dead_lettered_at IS NOT NULL))
);

COMMENT ON TABLE public.openai_ads_conversions IS
  'Durable, deduplicated outbox for OpenAI Ads order-created conversion delivery.';
COMMENT ON COLUMN public.openai_ads_conversions.event_id IS
  'Stable OpenAI Ads deduplication key in the form shopify_order_<Shopify ID>.';

COMMIT;
