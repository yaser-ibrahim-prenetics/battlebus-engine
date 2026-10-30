BEGIN;

CREATE TABLE public.channel_lift_request_identities (
  request_id text PRIMARY KEY CHECK (request_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  mode text NOT NULL CHECK (mode IN ('dry_run', 'live')),
  source text NOT NULL CHECK (source IN ('schedule', 'manual')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_lift_request_identity_tuple_unique
    UNIQUE (request_id, mode, source)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.channel_lift_runs
    GROUP BY request_id
    HAVING COUNT(DISTINCT mode) > 1 OR COUNT(DISTINCT source) > 1
  ) THEN
    RAISE EXCEPTION 'Existing channel-lift request IDs span multiple modes or sources';
  END IF;
END
$$;

INSERT INTO public.channel_lift_request_identities (request_id, mode, source, first_seen_at)
SELECT request_id, MIN(mode), MIN(source), MIN(created_at)
FROM public.channel_lift_runs
GROUP BY request_id;

ALTER TABLE public.channel_lift_runs
  ADD CONSTRAINT channel_lift_runs_request_identity_fkey
  FOREIGN KEY (request_id, mode, source)
  REFERENCES public.channel_lift_request_identities(request_id, mode, source)
  ON DELETE RESTRICT;

CREATE TABLE public.channel_lift_run_attempts (
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  run_id text NOT NULL REFERENCES public.channel_lift_runs(run_id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'live')),
  source text NOT NULL CHECK (source IN ('schedule', 'manual')),
  requested_by text CHECK (requested_by IS NULL OR length(requested_by) BETWEEN 1 AND 320),
  reason_code text,
  reference_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_lift_run_attempts_pkey PRIMARY KEY (request_id, run_id),
  CONSTRAINT channel_lift_attempt_request_identity_fkey
    FOREIGN KEY (request_id, mode, source)
    REFERENCES public.channel_lift_request_identities(request_id, mode, source)
    ON DELETE RESTRICT,
  CONSTRAINT channel_lift_attempt_reason_valid CHECK (
    (source = 'schedule' AND reason_code IS NULL AND reference_id IS NULL)
    OR (
      source = 'manual'
      AND reason_code IN (
        'parity_validation', 'live_canary', 'incident_recovery', 'operator_replay'
      )
      AND (
        reference_id IS NULL
        OR reference_id ~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$'
      )
    )
  )
);

CREATE INDEX idx_channel_lift_run_attempts_recent
  ON public.channel_lift_run_attempts (run_id, requested_at DESC);

ALTER TABLE public.channel_lift_run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_lift_request_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_lift_run_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.channel_lift_request_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.channel_lift_run_attempts TO battle_bus_runtime;
GRANT SELECT, INSERT ON public.channel_lift_request_identities TO battle_bus_runtime;
CREATE POLICY channel_lift_attempt_runtime ON public.channel_lift_run_attempts
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
CREATE POLICY channel_lift_request_identity_runtime ON public.channel_lift_request_identities
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

CREATE VIEW public.battle_hub_channel_lift_run_attempts AS
SELECT request_id, run_id, mode, source, requested_by, reason_code, reference_id, requested_at
FROM public.channel_lift_run_attempts;

CREATE VIEW public.battle_hub_channel_lift_request_identities AS
SELECT request_id, mode, source, first_seen_at
FROM public.channel_lift_request_identities;

REVOKE ALL ON public.battle_hub_channel_lift_run_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.battle_hub_channel_lift_request_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_channel_lift_run_attempts TO battle_hub_runtime;
GRANT SELECT ON public.battle_hub_channel_lift_request_identities TO battle_hub_runtime;

COMMENT ON TABLE public.channel_lift_run_attempts IS
  'Append-only, payload-free audit of additional requests that resume a channel-lift run.';
COMMENT ON VIEW public.battle_hub_channel_lift_run_attempts IS
  'Safe request-code audit for channel-lift run attempts and replays.';
COMMENT ON TABLE public.channel_lift_request_identities IS
  'Immutable mode and source binding for each channel-lift request ID across date ranges.';
COMMENT ON VIEW public.battle_hub_channel_lift_request_identities IS
  'Payload-free channel-lift request identity bindings for operator audit.';

COMMIT;
