BEGIN;

ALTER TABLE public.channel_lift_run_attempts
  DROP CONSTRAINT IF EXISTS channel_lift_attempt_run_identity_fkey;

ALTER TABLE public.channel_lift_runs
  DROP CONSTRAINT IF EXISTS channel_lift_runs_attempt_identity_unique;

COMMIT;
