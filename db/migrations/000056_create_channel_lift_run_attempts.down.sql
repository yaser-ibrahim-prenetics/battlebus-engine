BEGIN;

DROP VIEW IF EXISTS public.battle_hub_channel_lift_request_identities;
DROP VIEW IF EXISTS public.battle_hub_channel_lift_run_attempts;
DROP TABLE IF EXISTS public.channel_lift_run_attempts;
ALTER TABLE public.channel_lift_runs
  DROP CONSTRAINT IF EXISTS channel_lift_runs_request_identity_fkey;
ALTER TABLE public.channel_lift_runs
  DROP CONSTRAINT IF EXISTS channel_lift_runs_attempt_identity_unique;
DROP TABLE IF EXISTS public.channel_lift_request_identities;

COMMIT;
