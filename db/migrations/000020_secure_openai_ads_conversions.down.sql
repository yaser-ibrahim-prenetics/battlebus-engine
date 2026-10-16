BEGIN;

DROP VIEW IF EXISTS public.battle_hub_openai_ads_conversions;
DROP POLICY IF EXISTS openai_ads_conversions_service_role_all
  ON public.openai_ads_conversions;
REVOKE ALL ON TABLE public.openai_ads_conversions FROM service_role;
ALTER TABLE public.openai_ads_conversions DISABLE ROW LEVEL SECURITY;

COMMIT;
