BEGIN;

CREATE TABLE public.openai_ads_conversions (
  event_id text PRIMARY KEY,
  shopify_store text NOT NULL,
  shopify_order_id text NOT NULL,
  conversion_type text NOT NULL DEFAULT 'order_created',
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_http_status smallint,
  last_error_category text,
  last_error text,
  delivered_at timestamptz,
  permanent_at timestamptz,
  replay_count smallint NOT NULL DEFAULT 0,
  replayed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT openai_ads_conversion_identity UNIQUE (
    shopify_store, shopify_order_id, conversion_type
  ),
  CONSTRAINT openai_ads_event_id_shape CHECK (
    event_id ~ '^bb_order_created_[a-f0-9]{40}$'
  ),
  CONSTRAINT openai_ads_store_shape CHECK (
    length(shopify_store) BETWEEN 3 AND 253
    AND shopify_store = lower(shopify_store)
    AND shopify_store ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
  ),
  CONSTRAINT openai_ads_order_id_shape CHECK (shopify_order_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT openai_ads_conversion_type CHECK (conversion_type = 'order_created'),
  CONSTRAINT openai_ads_status CHECK (
    status IN (
      'queued', 'delivering', 'retry_wait', 'delivered', 'permanent_failure', 'skipped'
    )
  ),
  CONSTRAINT openai_ads_attempts CHECK (attempts BETWEEN 0 AND 6),
  CONSTRAINT openai_ads_replay_count CHECK (replay_count BETWEEN 0 AND 100),
  CONSTRAINT openai_ads_http_status CHECK (
    last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT openai_ads_error_category CHECK (
    last_error_category IS NULL
    OR (
      length(last_error_category) BETWEEN 1 AND 64
      AND last_error_category ~ '^[a-z0-9_]+$'
    )
  ),
  CONSTRAINT openai_ads_error_length CHECK (
    last_error IS NULL OR length(last_error) <= 1000
  ),
  CONSTRAINT openai_ads_lease_consistent CHECK (
    (status = 'delivering' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'delivering' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT openai_ads_delivered_consistent CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL AND permanent_at IS NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  ),
  CONSTRAINT openai_ads_permanent_consistent CHECK (
    (status IN ('permanent_failure', 'skipped') AND permanent_at IS NOT NULL)
    OR (status NOT IN ('permanent_failure', 'skipped') AND permanent_at IS NULL)
  )
);

CREATE INDEX idx_openai_ads_conversions_due
  ON public.openai_ads_conversions (next_attempt_at, created_at, event_id)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX idx_openai_ads_conversions_expired_lease
  ON public.openai_ads_conversions (lease_until, event_id)
  WHERE status = 'delivering';
CREATE INDEX idx_openai_ads_conversions_status
  ON public.openai_ads_conversions (status, updated_at DESC);

CREATE TRIGGER battle_platform_openai_ads_updated_at
  BEFORE UPDATE ON public.openai_ads_conversions
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.openai_ads_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openai_ads_conversions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.openai_ads_conversions TO battle_bus_runtime;
CREATE POLICY openai_ads_runtime ON public.openai_ads_conversions
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

CREATE VIEW public.battle_hub_openai_ads_conversions AS
SELECT
  event_id,
  shopify_store,
  shopify_order_id,
  conversion_type,
  occurred_at,
  status,
  attempts,
  next_attempt_at,
  last_http_status,
  last_error_category,
  delivered_at,
  permanent_at,
  replay_count,
  replayed_at,
  created_at,
  updated_at
FROM public.openai_ads_conversions;

REVOKE ALL ON public.battle_hub_openai_ads_conversions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_openai_ads_conversions TO battle_hub_runtime;

COMMENT ON TABLE public.openai_ads_conversions IS
  'Minimal durable outbox for deduplicated OpenAI Ads order-created conversions.';
COMMENT ON COLUMN public.openai_ads_conversions.event_id IS
  'Stable provider deduplication identity derived from store, order ID and conversion type.';
COMMENT ON VIEW public.battle_hub_openai_ads_conversions IS
  'Payload-free OpenAI Ads delivery status for Battle Hub operators.';

COMMIT;
