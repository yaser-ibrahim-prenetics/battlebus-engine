BEGIN;

DROP TABLE IF EXISTS public.pending_lifecycle_actions;
DROP FUNCTION IF EXISTS public.battle_platform_scrub_pending_action_payload();

COMMIT;
