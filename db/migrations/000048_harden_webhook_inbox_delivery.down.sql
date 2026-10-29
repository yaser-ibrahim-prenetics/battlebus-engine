BEGIN;

DROP TRIGGER IF EXISTS battle_platform_webhook_inbox_updated_at
  ON public.webhook_inbox;

DROP INDEX IF EXISTS public.idx_webhook_inbox_retention;
DROP INDEX IF EXISTS public.idx_webhook_inbox_dead_letter;
DROP INDEX IF EXISTS public.idx_webhook_inbox_expired_lease;
DROP INDEX IF EXISTS public.idx_webhook_inbox_ready;

ALTER TABLE public.webhook_inbox
  DROP CONSTRAINT webhook_inbox_dead_letter_consistent,
  DROP CONSTRAINT webhook_inbox_lease_consistent,
  DROP CONSTRAINT webhook_inbox_replay_count_nonnegative;

ALTER TABLE public.webhook_inbox
  DROP COLUMN dead_lettered_at,
  DROP COLUMN lease_expires_at,
  DROP COLUMN lease_token,
  DROP COLUMN next_attempt_at,
  DROP COLUMN last_replay_request_id,
  DROP COLUMN replay_count,
  DROP COLUMN updated_at;

COMMIT;
