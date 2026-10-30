BEGIN;

CREATE TABLE public.openai_ads_replay_requests (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  event_id text NOT NULL,
  actor_id text NOT NULL,
  actor_email text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT openai_ads_replay_request_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT openai_ads_replay_event_id CHECK (
    event_id ~ '^bb_order_created_[a-f0-9]{40}$'
  ),
  CONSTRAINT openai_ads_replay_actor_id CHECK (length(actor_id) BETWEEN 1 AND 100),
  CONSTRAINT openai_ads_replay_actor_email CHECK (length(actor_email) BETWEEN 3 AND 254),
  CONSTRAINT openai_ads_replay_reason CHECK (length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT openai_ads_replay_status CHECK (status IN ('pending', 'succeeded', 'rejected')),
  CONSTRAINT openai_ads_replay_completion CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status IN ('succeeded', 'rejected') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT openai_ads_replay_error CHECK (
    error_code IS NULL
    OR (length(error_code) BETWEEN 1 AND 64 AND error_code ~ '^[a-z0-9_]+$')
  )
);

CREATE INDEX idx_openai_ads_replay_event
  ON public.openai_ads_replay_requests (event_id, created_at DESC);

ALTER TABLE public.openai_ads_replay_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openai_ads_replay_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.openai_ads_replay_requests TO battle_bus_runtime;
GRANT UPDATE (status, error_code, completed_at)
  ON public.openai_ads_replay_requests TO battle_bus_runtime;
CREATE POLICY openai_ads_replay_runtime ON public.openai_ads_replay_requests
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

COMMENT ON TABLE public.openai_ads_replay_requests IS
  'Idempotent operator audit receipts for terminal OpenAI Ads conversion replay.';

COMMIT;
