BEGIN;

REVOKE SELECT ON public.battle_hub_openai_ads_conversions FROM battle_hub_runtime;
DROP VIEW public.battle_hub_openai_ads_conversions;

DROP POLICY openai_ads_runtime ON public.openai_ads_conversions;
REVOKE SELECT, INSERT, UPDATE ON public.openai_ads_conversions FROM battle_bus_runtime;
DROP TRIGGER battle_platform_openai_ads_updated_at ON public.openai_ads_conversions;
DROP TABLE public.openai_ads_conversions;

COMMIT;
