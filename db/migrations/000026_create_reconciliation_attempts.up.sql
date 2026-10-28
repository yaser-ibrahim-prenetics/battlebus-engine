CREATE TABLE public.reconciliation_attempts (
  id uuid PRIMARY KEY,
  workflow_run_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('salesorder','gps_us','gps_uk','fulfillment','inventory','direct_salesorder','direct_fulfillment')),
  scope text NOT NULL,
  range_start timestamptz,
  range_end timestamptz,
  status text NOT NULL CHECK (status IN ('running','matched','discrepancies','failed','skipped')),
  result jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((range_start IS NULL AND range_end IS NULL) OR (range_start IS NOT NULL AND range_end IS NOT NULL AND range_end > range_start)),
  CHECK ((status = 'running') = (completed_at IS NULL))
);
