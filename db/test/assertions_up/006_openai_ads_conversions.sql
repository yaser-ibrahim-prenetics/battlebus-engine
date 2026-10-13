INSERT INTO public.openai_ads_conversions (
  event_id, shopify_order_id, shopify_order_name, occurred_at
)
VALUES (
  'shopify_order_migration-test', 'migration-test', 'IM8-MIGRATION', now()
)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO public.openai_ads_conversions (
  event_id, shopify_order_id, shopify_order_name, occurred_at
)
VALUES (
  'shopify_order_migration-test', 'migration-test', 'IM8-DUPLICATE', now()
)
ON CONFLICT (event_id) DO NOTHING;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.openai_ads_conversions
    WHERE event_id = 'shopify_order_migration-test'
  ) <> 1 THEN
    RAISE EXCEPTION 'OpenAI Ads event ID did not deduplicate conversion rows';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.battle_hub_openai_ads_conversions
    WHERE event_id = 'shopify_order_migration-test'
      AND state = 'pending'
  ) THEN
    RAISE EXCEPTION 'Battle Hub OpenAI Ads view does not expose delivery state';
  END IF;

  IF has_table_privilege('battle_hub_runtime', 'public.openai_ads_conversions', 'SELECT') THEN
    RAISE EXCEPTION 'Battle Hub runtime can read the private OpenAI Ads outbox';
  END IF;

  IF NOT has_table_privilege(
    'battle_hub_runtime',
    'public.battle_hub_openai_ads_conversions',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Battle Hub runtime cannot read the OpenAI Ads delivery view';
  END IF;
END
$$;
