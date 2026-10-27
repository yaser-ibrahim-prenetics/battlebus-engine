CREATE TABLE public.fulfillment_action_aliases (
  provider text NOT NULL CHECK (provider IN ('gps', 'dynamics')),
  scope text NOT NULL,
  source_order_id text NOT NULL,
  alias_name text NOT NULL,
  action_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, scope, source_order_id, alias_name)
);
