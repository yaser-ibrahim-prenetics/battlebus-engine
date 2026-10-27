CREATE TABLE public.refund_hold_decisions (
  shop_domain text NOT NULL CHECK (length(shop_domain) > 0),
  source text NOT NULL CHECK (source IN ('shopify_webhook', 'loop_return_closed')),
  refund_id text NOT NULL CHECK (length(refund_id) > 0),
  order_id text NOT NULL CHECK (length(order_id) > 0),
  unfulfilled_line_count integer NOT NULL CHECK (unfulfilled_line_count >= 0),
  raised_at timestamptz NOT NULL,
  timestamp_source text NOT NULL CHECK (timestamp_source IN ('processed_at', 'created_at', 'first_seen')),
  hold_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_domain, source, refund_id),
  CHECK ((unfulfilled_line_count > 0) = (hold_until IS NOT NULL)),
  CHECK (hold_until IS NULL OR hold_until = raised_at + interval '24 hours')
);
