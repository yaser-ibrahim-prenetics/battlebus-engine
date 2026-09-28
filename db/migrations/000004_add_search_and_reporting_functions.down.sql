BEGIN;

DROP FUNCTION IF EXISTS public.get_order_directory_stats();
DROP FUNCTION IF EXISTS public.search_orders(text, integer, integer);

DROP INDEX IF EXISTS public.idx_inventory_sku_trgm;
DROP INDEX IF EXISTS public.idx_orders_customer_name_trgm;
DROP INDEX IF EXISTS public.idx_orders_customer_email_trgm;
DROP INDEX IF EXISTS public.idx_orders_order_number_trgm;
DROP INDEX IF EXISTS public.idx_orders_search;

COMMIT;
