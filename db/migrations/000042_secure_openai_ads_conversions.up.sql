BEGIN;

ALTER TABLE public.openai_ads_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.openai_ads_conversions FROM anon, authenticated, battle_hub_runtime;
GRANT ALL ON TABLE public.openai_ads_conversions TO service_role;

CREATE POLICY openai_ads_conversions_service_role_all
  ON public.openai_ads_conversions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE VIEW public.battle_hub_openai_ads_conversions
WITH (security_barrier = true)
AS
SELECT
  event_id,
  shopify_order_id,
  shopify_order_name,
  occurred_at,
  state,
  attempts,
  available_at,
  last_http_status,
  last_error,
  delivered_at,
  dead_lettered_at,
  created_at,
  updated_at
FROM public.openai_ads_conversions;

REVOKE ALL ON TABLE public.battle_hub_openai_ads_conversions FROM PUBLIC;
GRANT SELECT ON TABLE public.battle_hub_openai_ads_conversions TO battle_hub_runtime;

COMMENT ON VIEW public.battle_hub_openai_ads_conversions IS
  'Credential-free OpenAI Ads conversion delivery history for Battle Hub.';

COMMIT;
