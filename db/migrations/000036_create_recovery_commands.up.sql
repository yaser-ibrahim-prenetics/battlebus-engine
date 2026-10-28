CREATE TABLE public.recovery_commands (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  actor_id text NOT NULL,
  actor_email text NOT NULL,
  reason text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('reconcile_action','replay_inbox','reconcile','resume_order')),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','succeeded','failed')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status='queued')=(completed_at IS NULL))
);
CREATE INDEX recovery_commands_queued ON public.recovery_commands(created_at) WHERE status='queued';
