CREATE TABLE public.order_segment_fulfillments (
  shop_domain text NOT NULL,
  shopify_order_id text NOT NULL,
  fulfillment_id text NOT NULL,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  request_hash text NOT NULL,
  posting_date date NOT NULL,
  quantities jsonb NOT NULL CHECK (jsonb_typeof(quantities) = 'object'),
  include_services boolean NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_domain, shopify_order_id, fulfillment_id, segment_index),
  FOREIGN KEY (shop_domain, shopify_order_id) REFERENCES public.order_segment_plans
);
