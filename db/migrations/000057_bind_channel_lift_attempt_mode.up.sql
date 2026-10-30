BEGIN;

ALTER TABLE public.channel_lift_runs
  ADD CONSTRAINT channel_lift_runs_attempt_identity_unique
  UNIQUE (run_id, mode);

ALTER TABLE public.channel_lift_run_attempts
  ADD CONSTRAINT channel_lift_attempt_run_identity_fkey
  FOREIGN KEY (run_id, mode)
  REFERENCES public.channel_lift_runs(run_id, mode)
  ON DELETE RESTRICT;

COMMIT;
