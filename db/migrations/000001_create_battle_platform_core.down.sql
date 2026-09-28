BEGIN;

-- Development/test rollback only. Production deployments never run down
-- migrations automatically.
DROP TABLE IF EXISTS public.sku_mapping_audit_log;
DROP TABLE IF EXISTS public.sku_mappings;
DROP TABLE IF EXISTS public.user_preferences;
DROP TABLE IF EXISTS public.stocks;
DROP TABLE IF EXISTS public.products;
DROP TABLE IF EXISTS public.locations;
DROP TABLE IF EXISTS public.inventory;
DROP TABLE IF EXISTS public.order_lines;
DROP TABLE IF EXISTS public.orders;

DROP FUNCTION IF EXISTS public.battle_platform_set_updated_at();
DROP TYPE IF EXISTS public.order_priority;
DROP TYPE IF EXISTS public.order_status;

COMMIT;
