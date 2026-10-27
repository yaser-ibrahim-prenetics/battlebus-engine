CREATE TABLE public.d365_reconciliation_runs (
  id uuid PRIMARY KEY,
  workflow_run_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('salesorder', 'fulfillment')),
  shop_domain text NOT NULL,
  dynamics_origin text NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL CHECK (range_end > range_start),
  status text NOT NULL CHECK (status IN ('running', 'matched', 'discrepancies', 'failed')),
  result jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'running') = (completed_at IS NULL))
);
