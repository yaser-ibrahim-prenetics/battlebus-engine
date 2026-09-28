BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_search
  ON public.orders USING gin (
    to_tsvector(
      'english',
      COALESCE(order_number, '') || ' ' ||
      COALESCE(shopify_order_name, '') || ' ' ||
      COALESCE(customer_email, '') || ' ' ||
      COALESCE(customer_first_name, '') || ' ' ||
      COALESCE(customer_last_name, '')
    )
  );

CREATE INDEX IF NOT EXISTS idx_orders_order_number_trgm
  ON public.orders USING gin (order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email_trgm
  ON public.orders USING gin (customer_email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_customer_name_trgm
  ON public.orders USING gin (
    (COALESCE(customer_first_name, '') || ' ' || COALESCE(customer_last_name, ''))
    gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS idx_inventory_sku_trgm
  ON public.inventory USING gin (sku gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_orders(
  search_term text,
  result_limit integer DEFAULT 50,
  result_offset integer DEFAULT 0
)
RETURNS TABLE (
  id text,
  order_number text,
  title text,
  status public.order_status,
  priority public.order_priority,
  customer_email text,
  customer_first_name text,
  customer_last_name text,
  shopify_order_name text,
  warehouse text,
  created_at timestamptz,
  updated_at timestamptz,
  rank real
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    o.id,
    o.order_number,
    o.title,
    o.status,
    o.priority,
    o.customer_email,
    o.customer_first_name,
    o.customer_last_name,
    o.shopify_order_name,
    o.warehouse,
    o.created_at,
    o.updated_at,
    ts_rank(
      to_tsvector(
        'english',
        COALESCE(o.order_number, '') || ' ' ||
        COALESCE(o.shopify_order_name, '') || ' ' ||
        COALESCE(o.customer_email, '') || ' ' ||
        COALESCE(o.customer_first_name, '') || ' ' ||
        COALESCE(o.customer_last_name, '')
      ),
      plainto_tsquery('english', search_term)
    ) AS rank
  FROM public.orders AS o
  WHERE
    to_tsvector(
      'english',
      COALESCE(o.order_number, '') || ' ' ||
      COALESCE(o.shopify_order_name, '') || ' ' ||
      COALESCE(o.customer_email, '') || ' ' ||
      COALESCE(o.customer_first_name, '') || ' ' ||
      COALESCE(o.customer_last_name, '')
    ) @@ plainto_tsquery('english', search_term)
    OR o.order_number ILIKE '%' || search_term || '%'
    OR o.customer_email ILIKE '%' || search_term || '%'
    OR o.shopify_order_name ILIKE '%' || search_term || '%'
  ORDER BY rank DESC, o.created_at DESC
  LIMIT LEAST(GREATEST(result_limit, 1), 200)
  OFFSET GREATEST(result_offset, 0);
$$;

CREATE OR REPLACE FUNCTION public.get_order_directory_stats()
RETURNS TABLE (
  total bigint,
  pending bigint,
  processing bigint,
  completed bigint,
  failed bigint,
  cancelled bigint,
  sync_issues bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE status = 'pending')::bigint,
    count(*) FILTER (WHERE status = 'processing')::bigint,
    count(*) FILTER (WHERE status = 'completed')::bigint,
    count(*) FILTER (WHERE status = 'failed')::bigint,
    count(*) FILTER (WHERE status = 'cancelled')::bigint,
    count(*) FILTER (
      WHERE shopify_sync_status ILIKE '%failed%'
        OR d365_sync_status ILIKE '%failed%'
        OR gps_sync_status ILIKE '%failed%'
    )::bigint
  FROM public.orders;
$$;

REVOKE ALL ON FUNCTION public.search_orders(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_directory_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_orders(text, integer, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_directory_stats()
  TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgrst') THEN
    PERFORM pg_notify('pgrst', 'reload schema');
  END IF;
END
$$;

COMMIT;
