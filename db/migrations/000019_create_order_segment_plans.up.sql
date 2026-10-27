CREATE TABLE public.order_segment_plans (
  shop_domain text NOT NULL,
  shopify_order_id text NOT NULL,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_domain, shopify_order_id)
);
