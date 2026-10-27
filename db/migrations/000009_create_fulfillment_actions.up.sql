CREATE TABLE public.fulfillment_actions (
  action_key text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('gps', 'dynamics')),
  scope text NOT NULL,
  source_order_id text NOT NULL,
  source_line_id text NOT NULL,
  action_name text NOT NULL,
  request_hash text NOT NULL,
  attempt_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'uncertain')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'succeeded') = (result IS NOT NULL))
);
