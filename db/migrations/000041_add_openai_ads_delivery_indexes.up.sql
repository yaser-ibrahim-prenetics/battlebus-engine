BEGIN;

CREATE INDEX IF NOT EXISTS idx_openai_ads_conversions_pending
  ON public.openai_ads_conversions (available_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_openai_ads_conversions_expired_lease
  ON public.openai_ads_conversions (lease_expires_at)
  WHERE state = 'delivering';

CREATE INDEX IF NOT EXISTS idx_openai_ads_conversions_order
  ON public.openai_ads_conversions (shopify_order_id, created_at DESC);

COMMIT;
