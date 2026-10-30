BEGIN;

CREATE TABLE public.channel_lift_runs (
  run_id text PRIMARY KEY,
  reporting_date date NOT NULL,
  mode text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts smallint NOT NULL DEFAULT 0,
  expected_rows integer,
  expected_orders integer,
  expected_pairs integer,
  mapped_pairs integer,
  eligible_events integer,
  exclusion_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  batch_count integer NOT NULL DEFAULT 0,
  attempted_events integer NOT NULL DEFAULT 0,
  delivered_events integer NOT NULL DEFAULT 0,
  config_hash text,
  snapshot_hash text,
  last_error_code text,
  requested_by text,
  request_reason text,
  eligibility_cutoff_seconds bigint NOT NULL DEFAULT (
    EXTRACT(EPOCH FROM clock_timestamp())::bigint
  ),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_lift_run_id_shape CHECK (
    run_id ~ '^channel_lift_[a-f0-9]{64}$'
  ),
  CONSTRAINT channel_lift_mode_valid CHECK (mode IN ('dry_run', 'live')),
  CONSTRAINT channel_lift_source_valid CHECK (source IN ('schedule', 'manual')),
  CONSTRAINT channel_lift_status_valid CHECK (
    status IN ('queued', 'running', 'dry_run_completed', 'completed', 'failed')
  ),
  CONSTRAINT channel_lift_attempts_valid CHECK (attempts BETWEEN 0 AND 100),
  CONSTRAINT channel_lift_counts_valid CHECK (
    (expected_rows IS NULL OR expected_rows >= 0)
    AND (expected_orders IS NULL OR expected_orders >= 0)
    AND (expected_pairs IS NULL OR expected_pairs >= 0)
    AND (mapped_pairs IS NULL OR mapped_pairs >= 0)
    AND (eligible_events IS NULL OR eligible_events >= 0)
    AND batch_count >= 0
    AND attempted_events >= 0
    AND delivered_events >= 0
    AND delivered_events <= attempted_events
  ),
  CONSTRAINT channel_lift_hashes_valid CHECK (
    (config_hash IS NULL OR config_hash ~ '^[a-f0-9]{64}$')
    AND (snapshot_hash IS NULL OR snapshot_hash ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT channel_lift_error_code_valid CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  CONSTRAINT channel_lift_requested_by_length CHECK (
    requested_by IS NULL OR length(requested_by) BETWEEN 1 AND 320
  ),
  CONSTRAINT channel_lift_request_reason_valid CHECK (
    (source = 'schedule' AND request_reason IS NULL)
    OR (source = 'manual' AND length(request_reason) BETWEEN 10 AND 1000)
  ),
  CONSTRAINT channel_lift_eligibility_cutoff_valid CHECK (
    eligibility_cutoff_seconds BETWEEN 1 AND 253402300799
  ),
  CONSTRAINT channel_lift_exclusions_object CHECK (
    jsonb_typeof(exclusion_counts) = 'object'
    AND pg_column_size(exclusion_counts) <= 8192
  ),
  CONSTRAINT channel_lift_terminal_time CHECK (
    (status IN ('dry_run_completed', 'completed', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND completed_at IS NULL)
  ),
  CONSTRAINT channel_lift_started_time CHECK (
    (status = 'queued' AND started_at IS NULL)
    OR (status <> 'queued' AND started_at IS NOT NULL)
  ),
  CONSTRAINT channel_lift_date_mode_unique UNIQUE (reporting_date, mode)
);

CREATE UNIQUE INDEX idx_channel_lift_one_active_date
  ON public.channel_lift_runs (reporting_date)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_channel_lift_runs_recent
  ON public.channel_lift_runs (reporting_date DESC, mode, created_at DESC);

CREATE INDEX idx_channel_lift_runs_failures
  ON public.channel_lift_runs (completed_at DESC, reporting_date DESC)
  WHERE status = 'failed';

CREATE TRIGGER battle_platform_channel_lift_updated_at
  BEFORE UPDATE ON public.channel_lift_runs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.channel_lift_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_lift_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.channel_lift_runs TO battle_bus_runtime;
CREATE POLICY channel_lift_runtime ON public.channel_lift_runs
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

CREATE VIEW public.battle_hub_channel_lift_runs AS
SELECT
  run_id,
  reporting_date,
  mode,
  source,
  status,
  attempts,
  expected_rows,
  expected_orders,
  expected_pairs,
  mapped_pairs,
  eligible_events,
  exclusion_counts,
  batch_count,
  attempted_events,
  delivered_events,
  config_hash,
  snapshot_hash,
  last_error_code,
  request_reason,
  eligibility_cutoff_seconds,
  started_at,
  completed_at,
  created_at,
  updated_at
FROM public.channel_lift_runs;

REVOKE ALL ON public.battle_hub_channel_lift_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.battle_hub_channel_lift_runs TO battle_hub_runtime;

COMMENT ON TABLE public.channel_lift_runs IS
  'Privacy-safe evidence for deterministic Triple Whale to Meta channel-lift runs.';
COMMENT ON COLUMN public.channel_lift_runs.exclusion_counts IS
  'Bounded counts by safe validation reason; never contains source rows or customer identity.';
COMMENT ON VIEW public.battle_hub_channel_lift_runs IS
  'Payload-free channel-lift delivery evidence for Battle Hub operators.';

COMMIT;
