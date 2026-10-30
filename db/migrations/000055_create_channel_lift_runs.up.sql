BEGIN;

CREATE TABLE public.channel_lift_runs (
  run_id text PRIMARY KEY,
  reporting_date date NOT NULL,
  mode text NOT NULL,
  source text NOT NULL,
  request_id text NOT NULL,
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
  reason_code text,
  reference_id text,
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
  CONSTRAINT channel_lift_request_id_valid CHECK (
    request_id ~ '^[A-Za-z0-9:_-]{1,200}$'
  ),
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
  CONSTRAINT channel_lift_reason_code_valid CHECK (
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

CREATE FUNCTION public.battle_platform_enforce_channel_lift_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime_actor boolean := NOT COALESCE(
      (SELECT roles.rolsuper FROM pg_roles AS roles WHERE roles.rolname = current_user),
      false
    )
    AND (
      current_user = 'battle_bus_runtime'
      OR pg_has_role(current_user, 'battle_bus_runtime', 'member')
    );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF runtime_actor AND (
      NEW.status <> 'queued'
      OR NEW.attempts <> 0
      OR NEW.expected_rows IS NOT NULL
      OR NEW.expected_orders IS NOT NULL
      OR NEW.expected_pairs IS NOT NULL
      OR NEW.mapped_pairs IS NOT NULL
      OR NEW.eligible_events IS NOT NULL
      OR NEW.exclusion_counts <> '{}'::jsonb
      OR NEW.batch_count <> 0
      OR NEW.attempted_events <> 0
      OR NEW.delivered_events <> 0
      OR NEW.config_hash IS NOT NULL
      OR NEW.snapshot_hash IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR abs(NEW.eligibility_cutoff_seconds - EXTRACT(EPOCH FROM clock_timestamp())::bigint) > 300
    ) THEN
      RAISE EXCEPTION 'Runtime role can insert only fresh queued channel-lift runs';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.reporting_date IS DISTINCT FROM OLD.reporting_date
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
    OR NEW.eligibility_cutoff_seconds IS DISTINCT FROM OLD.eligibility_cutoff_seconds
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Channel-lift identity and audit fields are immutable';
  END IF;

  IF OLD.status IN ('dry_run_completed', 'completed') THEN
    RAISE EXCEPTION 'Terminal channel-lift runs are immutable';
  END IF;

  IF OLD.snapshot_hash IS NOT NULL AND (
    NEW.expected_rows IS DISTINCT FROM OLD.expected_rows
    OR NEW.expected_orders IS DISTINCT FROM OLD.expected_orders
    OR NEW.expected_pairs IS DISTINCT FROM OLD.expected_pairs
    OR NEW.mapped_pairs IS DISTINCT FROM OLD.mapped_pairs
    OR NEW.eligible_events IS DISTINCT FROM OLD.eligible_events
    OR NEW.exclusion_counts IS DISTINCT FROM OLD.exclusion_counts
    OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
  ) THEN
    RAISE EXCEPTION 'Prepared channel-lift evidence is immutable';
  END IF;

  IF NEW.batch_count < OLD.batch_count
    OR NEW.attempted_events < OLD.attempted_events
    OR NEW.delivered_events < OLD.delivered_events
  THEN
    RAISE EXCEPTION 'Channel-lift delivery progress must be monotonic';
  END IF;

  IF OLD.status = 'queued' AND NEW.status = 'running' THEN
    IF NEW.attempts <> OLD.attempts + 1
      OR NEW.started_at IS NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'Invalid initial channel-lift claim';
    END IF;
  ELSIF OLD.status = 'failed' AND NEW.status = 'running' THEN
    IF NEW.attempts <> OLD.attempts + 1
      OR NEW.started_at IS NOT DISTINCT FROM OLD.started_at
      OR NEW.completed_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.expected_rows IS DISTINCT FROM OLD.expected_rows
      OR NEW.expected_orders IS DISTINCT FROM OLD.expected_orders
      OR NEW.expected_pairs IS DISTINCT FROM OLD.expected_pairs
      OR NEW.mapped_pairs IS DISTINCT FROM OLD.mapped_pairs
      OR NEW.eligible_events IS DISTINCT FROM OLD.eligible_events
      OR NEW.exclusion_counts IS DISTINCT FROM OLD.exclusion_counts
      OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
      OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
      OR NEW.batch_count IS DISTINCT FROM OLD.batch_count
      OR NEW.attempted_events IS DISTINCT FROM OLD.attempted_events
      OR NEW.delivered_events IS DISTINCT FROM OLD.delivered_events
    THEN
      RAISE EXCEPTION 'Invalid failed channel-lift retry';
    END IF;
  ELSIF OLD.status = 'running' AND NEW.status = 'running' THEN
    IF NEW.attempts = OLD.attempts + 1 THEN
      IF OLD.updated_at >= clock_timestamp() - interval '2 hours'
        OR NEW.started_at IS NOT DISTINCT FROM OLD.started_at
        OR NEW.completed_at IS NOT NULL
        OR NEW.last_error_code IS NOT NULL
        OR NEW.expected_rows IS DISTINCT FROM OLD.expected_rows
        OR NEW.expected_orders IS DISTINCT FROM OLD.expected_orders
        OR NEW.expected_pairs IS DISTINCT FROM OLD.expected_pairs
        OR NEW.mapped_pairs IS DISTINCT FROM OLD.mapped_pairs
        OR NEW.eligible_events IS DISTINCT FROM OLD.eligible_events
        OR NEW.exclusion_counts IS DISTINCT FROM OLD.exclusion_counts
        OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
        OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
        OR NEW.batch_count IS DISTINCT FROM OLD.batch_count
        OR NEW.attempted_events IS DISTINCT FROM OLD.attempted_events
        OR NEW.delivered_events IS DISTINCT FROM OLD.delivered_events
      THEN
        RAISE EXCEPTION 'Invalid stale channel-lift reclaim';
      END IF;
    ELSIF NEW.attempts <> OLD.attempts
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.completed_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'Invalid in-place channel-lift update';
    END IF;
  ELSIF OLD.status = 'running'
    AND NEW.status IN ('dry_run_completed', 'completed', 'failed')
  THEN
    IF NEW.attempts <> OLD.attempts OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'Invalid terminal channel-lift transition';
    END IF;
    IF NEW.status = 'dry_run_completed' AND (
      NEW.mode <> 'dry_run' OR NEW.attempted_events <> 0 OR NEW.delivered_events <> 0
    ) THEN
      RAISE EXCEPTION 'Invalid dry-run completion evidence';
    END IF;
    IF NEW.status = 'completed' AND (
      NEW.mode <> 'live'
      OR NEW.eligible_events IS NULL
      OR NEW.attempted_events <> NEW.eligible_events
      OR NEW.delivered_events <> NEW.attempted_events
    ) THEN
      RAISE EXCEPTION 'Invalid live completion evidence';
    END IF;
    IF NEW.status = 'failed' AND NEW.last_error_code IS NULL THEN
      RAISE EXCEPTION 'Failed channel-lift runs require a safe error code';
    END IF;
    IF NEW.status <> 'failed' AND NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'Successful channel-lift runs cannot retain an error code';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid channel-lift transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER battle_platform_enforce_channel_lift_transition
  BEFORE INSERT OR UPDATE ON public.channel_lift_runs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_enforce_channel_lift_transition();

REVOKE ALL ON FUNCTION public.battle_platform_enforce_channel_lift_transition() FROM PUBLIC;

CREATE TRIGGER battle_platform_channel_lift_updated_at
  BEFORE UPDATE ON public.channel_lift_runs
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

ALTER TABLE public.channel_lift_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_lift_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.channel_lift_runs TO battle_bus_runtime;
GRANT UPDATE (
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
  started_at,
  completed_at
) ON public.channel_lift_runs TO battle_bus_runtime;
CREATE POLICY channel_lift_runtime ON public.channel_lift_runs
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);

CREATE VIEW public.battle_hub_channel_lift_runs AS
SELECT
  run_id,
  reporting_date,
  mode,
  source,
  request_id,
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
  reason_code,
  reference_id,
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
COMMENT ON FUNCTION public.battle_platform_enforce_channel_lift_transition() IS
  'Protects channel-lift audit identity, snapshot evidence, monotonic progress, and terminal rows from runtime rewrites.';
COMMENT ON VIEW public.battle_hub_channel_lift_runs IS
  'Payload-free channel-lift delivery evidence for Battle Hub operators.';

COMMIT;
