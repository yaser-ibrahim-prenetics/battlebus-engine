BEGIN;

DROP VIEW IF EXISTS public.battle_hub_channel_lift_runs;
DROP TABLE IF EXISTS public.channel_lift_runs;
DROP FUNCTION IF EXISTS public.battle_platform_enforce_channel_lift_transition();

COMMIT;
