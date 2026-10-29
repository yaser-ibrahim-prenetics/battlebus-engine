BEGIN;

DROP INDEX public.idx_oos_dependency_replay_token;

ALTER TABLE public.oos_recovery_dependencies
  DROP COLUMN replay_token;

COMMIT;
