BEGIN;
CREATE TABLE public.workflow_run_health (
  run_id text PRIMARY KEY,
  function_id text NOT NULL,
  event_name text NOT NULL,
  revision text NOT NULL,
  received_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  CHECK ((status = 'running') = (completed_at IS NULL))
);
COMMIT;
