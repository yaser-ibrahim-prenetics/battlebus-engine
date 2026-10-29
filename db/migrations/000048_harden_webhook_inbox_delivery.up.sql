BEGIN;

ALTER TABLE public.webhook_inbox
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN replay_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_replay_request_id uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT webhook_inbox_replay_count_nonnegative CHECK (replay_count >= 0),
  ADD CONSTRAINT webhook_inbox_lease_consistent
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND status <> 'published')
    ),
  ADD CONSTRAINT webhook_inbox_dead_letter_consistent
    CHECK (
      dead_lettered_at IS NULL
      OR (status = 'failed' AND lease_token IS NULL AND lease_expires_at IS NULL)
    );

UPDATE public.webhook_inbox
SET next_attempt_at = COALESCE(published_at, received_at),
    updated_at = COALESCE(published_at, received_at);

CREATE INDEX idx_webhook_inbox_ready
  ON public.webhook_inbox (next_attempt_at, received_at, id)
  WHERE status IN ('received', 'failed')
    AND dead_lettered_at IS NULL;

CREATE INDEX idx_webhook_inbox_expired_lease
  ON public.webhook_inbox (lease_expires_at, id)
  WHERE lease_token IS NOT NULL;

CREATE INDEX idx_webhook_inbox_dead_letter
  ON public.webhook_inbox (dead_lettered_at DESC, id)
  WHERE status = 'failed' AND dead_lettered_at IS NOT NULL;

CREATE INDEX idx_webhook_inbox_retention
  ON public.webhook_inbox (published_at, id)
  WHERE status = 'published';

CREATE TRIGGER battle_platform_webhook_inbox_updated_at
  BEFORE UPDATE ON public.webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

COMMENT ON COLUMN public.webhook_inbox.next_attempt_at IS
  'Earliest time a received or failed receipt may be claimed for publication.';
COMMENT ON COLUMN public.webhook_inbox.lease_token IS
  'Exact worker claim token required to publish or fail an active delivery attempt.';
COMMENT ON COLUMN public.webhook_inbox.lease_expires_at IS
  'Bounded claim expiry used to recover work after a worker crash.';
COMMENT ON COLUMN public.webhook_inbox.dead_lettered_at IS
  'Terminal failed-publication time. Non-null failed rows require an audited operator replay.';
COMMENT ON COLUMN public.webhook_inbox.replay_count IS
  'Number of audited operator replays after terminal delivery failure.';
COMMENT ON COLUMN public.webhook_inbox.last_replay_request_id IS
  'Stable recovery command ID that makes dead-letter replay idempotent.';

COMMIT;
