BEGIN;

DROP INDEX IF EXISTS public.idx_openai_ads_conversions_order;
DROP INDEX IF EXISTS public.idx_openai_ads_conversions_expired_lease;
DROP INDEX IF EXISTS public.idx_openai_ads_conversions_pending;

COMMIT;
