CREATE TABLE public.workflow_observations (
  run_id text PRIMARY KEY,
  function_id text NOT NULL,
  event_id text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  waiting_until timestamptz,
  unknown_wait boolean NOT NULL DEFAULT false,
  completed_at timestamptz
);
