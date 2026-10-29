BEGIN;

ALTER TABLE public.oos_recovery_dependencies
  ADD COLUMN replay_token uuid;

CREATE INDEX idx_oos_dependency_replay_token
  ON public.oos_recovery_dependencies (replay_token)
  WHERE replay_token IS NOT NULL;

COMMENT ON COLUMN public.oos_recovery_dependencies.replay_token IS
  'Correlates one targeted replay with its outcomes so stale runs cannot settle newer attempts.';

COMMIT;
