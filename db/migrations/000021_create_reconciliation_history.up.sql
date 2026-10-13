BEGIN;

CREATE TABLE IF NOT EXISTS public.reconciliation_history (
  audit_id uuid PRIMARY KEY,
  run_id text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  store_code text NOT NULL,
  reconciliation_type text NOT NULL,
  trigger_type text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  window_start timestamptz NOT NULL,
  window_end_exclusive timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running',
  total_orders integer NOT NULL DEFAULT 0,
  matched_orders integer NOT NULL DEFAULT 0,
  discrepancy_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_history_type_valid
    CHECK (reconciliation_type IN ('salesorder', 'gps_us', 'gps_uk', 'fulfillment')),
  CONSTRAINT reconciliation_history_trigger_valid
    CHECK (trigger_type IN ('cron', 'manual')),
  CONSTRAINT reconciliation_history_status_valid
    CHECK (status IN ('running', 'passed', 'failed')),
  CONSTRAINT reconciliation_history_attempt_positive CHECK (attempt > 0),
  CONSTRAINT reconciliation_history_counts_nonnegative
    CHECK (total_orders >= 0 AND matched_orders >= 0 AND discrepancy_count >= 0),
  CONSTRAINT reconciliation_history_dates_valid CHECK (date_from <= date_to),
  CONSTRAINT reconciliation_history_window_valid CHECK (window_start < window_end_exclusive),
  CONSTRAINT reconciliation_history_completion_consistent
    CHECK ((status = 'running') = (completed_at IS NULL)),
  CONSTRAINT reconciliation_history_run_attempt_unique
    UNIQUE (run_id, reconciliation_type, attempt)
);

COMMENT ON TABLE public.reconciliation_history IS
  'Structured, queryable audit history for every Battle Bus reconciliation check.';
COMMENT ON COLUMN public.reconciliation_history.details IS
  'Typed discrepancy buckets and affected Shopify order names/IDs for Battle Hub recovery actions.';

COMMIT;
