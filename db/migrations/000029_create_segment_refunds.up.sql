CREATE TABLE public.order_segment_refunds (
  shop_domain text NOT NULL,
  shopify_order_id text NOT NULL,
  refund_id text NOT NULL,
  request_hash text NOT NULL,
  allocations jsonb NOT NULL CHECK (jsonb_typeof(allocations) = 'array'),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (shop_domain, shopify_order_id, refund_id),
  FOREIGN KEY (shop_domain, shopify_order_id) REFERENCES public.order_segment_plans(shop_domain, shopify_order_id),
  CHECK (completed = (completed_at IS NOT NULL))
);
