-- Supabase creates these group roles automatically. Cloud SQL is plain
-- PostgreSQL, so bootstrap the same least-privilege role names before the
-- schema grants and RLS policies below are installed. They are NOLOGIN roles;
-- concrete application identities are granted membership separately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

BEGIN;

-- Release 1 is intentionally additive. It creates the shared operational
-- schema used by Battle Bus and Battle Hub without deleting legacy columns or
-- data. Destructive cleanup belongs in a later contract migration.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'order_status'
  ) THEN
    CREATE TYPE public.order_status AS ENUM (
      'pending', 'processing', 'completed', 'failed', 'cancelled'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'order_priority'
  ) THEN
    CREATE TYPE public.order_priority AS ENUM ('low', 'medium', 'high', 'urgent');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.battle_platform_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.orders (
  id text PRIMARY KEY,
  order_number text NOT NULL,
  title text NOT NULL,
  description text,
  status public.order_status NOT NULL DEFAULT 'pending',
  priority public.order_priority NOT NULL DEFAULT 'medium',
  state jsonb,
  platform text,
  -- Retained during the expand phase for compatibility with older Hub builds.
  platform_order_id text,
  platform_order_name text,
  shopify_order_id text,
  shopify_order_name text,
  shopify_sync_status text,
  d365_order_number text,
  d365_sync_status text,
  d365_fulfillment_status text NOT NULL DEFAULT 'pending',
  gps_order_no text,
  gps_uk_order_no text,
  gps_sync_status text,
  gps_fulfillment_status text NOT NULL DEFAULT 'pending',
  fulfillment_source text,
  warehouse text,
  last_sync timestamptz,
  shopify_financial_status text,
  shopify_fulfillment_status text,
  shopify_cancelled_at timestamptz,
  shopify_cancel_reason text,
  processing_status text,
  last_error text,
  last_error_type text,
  retry_at timestamptz,
  customer_email text,
  customer_first_name text,
  customer_last_name text,
  user_id text,
  user_data jsonb,
  pending_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_pending_actions_array
    CHECK (jsonb_typeof(pending_actions) = 'array')
);

-- Known expand-only columns are repeated as ALTER statements so this migration
-- can safely complete a partially bootstrapped development database.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pending_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS d365_fulfillment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS gps_fulfillment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS fulfillment_source text,
  ADD COLUMN IF NOT EXISTS gps_uk_order_no text;

CREATE INDEX IF NOT EXISTS idx_orders_order_number
  ON public.orders (order_number);
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id
  ON public.orders (shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_name
  ON public.orders (shopify_order_name);
CREATE INDEX IF NOT EXISTS idx_orders_status
  ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_warehouse
  ON public.orders (warehouse);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email
  ON public.orders (customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_platform
  ON public.orders (platform);
CREATE INDEX IF NOT EXISTS idx_orders_d365_fulfillment
  ON public.orders (d365_fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_gps_fulfillment
  ON public.orders (gps_fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_source
  ON public.orders (fulfillment_source);
CREATE INDEX IF NOT EXISTS idx_orders_gps_uk_order_no
  ON public.orders (gps_uk_order_no)
  WHERE gps_uk_order_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL,
  shopify_order_name text,
  shopify_line_item_id text NOT NULL,
  shopify_sku text,
  d365_item_number text NOT NULL,
  d365_sales_order_number text,
  data_area_id text,
  quantity numeric NOT NULL DEFAULT 1,
  price numeric,
  dynamics_inventory_lot_id text,
  is_service_line boolean NOT NULL DEFAULT false,
  is_fulfilled_to_dynamics boolean NOT NULL DEFAULT false,
  fulfilled_at timestamptz,
  refund_id text,
  credit_note_number text,
  exchange_rate numeric,
  exchange_rate_source text,
  source_currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_lines_shopify_line_unique
    UNIQUE (shopify_order_id, shopify_line_item_id)
);

ALTER TABLE public.order_lines
  ADD COLUMN IF NOT EXISTS refund_id text,
  ADD COLUMN IF NOT EXISTS credit_note_number text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS exchange_rate_source text,
  ADD COLUMN IF NOT EXISTS source_currency text;

CREATE INDEX IF NOT EXISTS idx_order_lines_shopify_order_id
  ON public.order_lines (shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_shopify_order_name
  ON public.order_lines (shopify_order_name);
CREATE INDEX IF NOT EXISTS idx_order_lines_d365_so_number
  ON public.order_lines (d365_sales_order_number);
CREATE INDEX IF NOT EXISTS idx_order_lines_service
  ON public.order_lines (shopify_order_id, is_service_line);
CREATE INDEX IF NOT EXISTS idx_order_lines_refund_id
  ON public.order_lines (refund_id)
  WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_lines_shopify_order_line_item
  ON public.order_lines (shopify_order_id, shopify_line_item_id);

CREATE TABLE IF NOT EXISTS public.inventory (
  id text PRIMARY KEY,
  sku text NOT NULL,
  name text NOT NULL,
  description text,
  quantity_available integer NOT NULL DEFAULT 0,
  quantity_reserved integer NOT NULL DEFAULT 0,
  gps_quantity integer,
  shopify_quantity integer,
  d365_quantity integer,
  shopify_product_id text,
  shopify_sync_status text,
  d365_item_id text,
  d365_sync_status text,
  warehouse text,
  last_sync timestamptz,
  gps_last_sync timestamptz,
  shopify_last_sync timestamptz,
  d365_last_sync timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_sku ON public.inventory (sku);
CREATE INDEX IF NOT EXISTS idx_inventory_shopify_product_id
  ON public.inventory (shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_d365_item_id
  ON public.inventory (d365_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_warehouse
  ON public.inventory (warehouse);
CREATE INDEX IF NOT EXISTS idx_inventory_shopify_sync_status
  ON public.inventory (shopify_sync_status);
CREATE INDEX IF NOT EXISTS idx_inventory_d365_sync_status
  ON public.inventory (d365_sync_status);

CREATE TABLE IF NOT EXISTS public.sku_mappings (
  id text PRIMARY KEY,
  shopify_sku text NOT NULL,
  d365_sku text,
  type text NOT NULL DEFAULT 'merge',
  status text NOT NULL DEFAULT 'active',
  description text,
  bundle_components jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sku_mappings_bundle_components_check
    CHECK (
      type <> 'bundle'
      OR (
        bundle_components IS NOT NULL
        AND jsonb_typeof(bundle_components) = 'array'
        AND jsonb_array_length(bundle_components) > 0
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_sku_mappings_shopify_sku
  ON public.sku_mappings (shopify_sku);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_d365_sku
  ON public.sku_mappings (d365_sku);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_status
  ON public.sku_mappings (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_mappings_unique_type_shopify_d365
  ON public.sku_mappings (type, shopify_sku, COALESCE(d365_sku, ''));

CREATE TABLE IF NOT EXISTS public.sku_mapping_audit_log (
  id text PRIMARY KEY,
  mapping_id text REFERENCES public.sku_mappings(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  changed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_mapping_audit_log_mapping_id
  ON public.sku_mapping_audit_log (mapping_id);
CREATE INDEX IF NOT EXISTS idx_sku_mapping_audit_log_action
  ON public.sku_mapping_audit_log (action);

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  theme text NOT NULL DEFAULT 'system',
  font text NOT NULL DEFAULT 'inter',
  settings jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
  ON public.user_preferences (user_id);

CREATE TABLE IF NOT EXISTS public.locations (
  id text PRIMARY KEY,
  name text NOT NULL,
  shopify_location_id text NOT NULL UNIQUE,
  warehouse_name text,
  dynamics_data_area_id text,
  country_data_area_mapping jsonb NOT NULL DEFAULT '[]'::jsonb,
  address_line1 text,
  address_line2 text,
  city text,
  province text,
  country text,
  zip text,
  phone text,
  active boolean NOT NULL DEFAULT true,
  fulfillment_service_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_country_data_area_mapping_array
    CHECK (jsonb_typeof(country_data_area_mapping) = 'array')
);

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS dynamics_data_area_id text,
  ADD COLUMN IF NOT EXISTS country_data_area_mapping jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_locations_shopify_location_id
  ON public.locations (shopify_location_id);
CREATE INDEX IF NOT EXISTS idx_locations_warehouse_name
  ON public.locations (warehouse_name);
CREATE INDEX IF NOT EXISTS idx_locations_active
  ON public.locations (active);
CREATE INDEX IF NOT EXISTS idx_locations_dynamics_data_area_id
  ON public.locations (dynamics_data_area_id);

CREATE TABLE IF NOT EXISTS public.stocks (
  id text PRIMARY KEY,
  sku text NOT NULL,
  location_id text NOT NULL,
  location_name text,
  warehouse text NOT NULL,
  quantity_available integer NOT NULL DEFAULT 0,
  quantity_reserved integer NOT NULL DEFAULT 0,
  quantity_committed integer NOT NULL DEFAULT 0,
  quantity_on_hand integer NOT NULL DEFAULT 0,
  shopify_product_id text,
  shopify_variant_id bigint,
  shopify_inventory_item_id bigint,
  shopify_sync_status text,
  d365_item_id text,
  d365_sync_status text,
  status text NOT NULL DEFAULT 'active',
  last_sync timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stocks_sku ON public.stocks (sku);
CREATE INDEX IF NOT EXISTS idx_stocks_location_id ON public.stocks (location_id);
CREATE INDEX IF NOT EXISTS idx_stocks_warehouse ON public.stocks (warehouse);
CREATE INDEX IF NOT EXISTS idx_stocks_shopify_product_id
  ON public.stocks (shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_stocks_shopify_inventory_item_id
  ON public.stocks (shopify_inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_stocks_d365_item_id
  ON public.stocks (d365_item_id);
CREATE INDEX IF NOT EXISTS idx_stocks_status ON public.stocks (status);
CREATE INDEX IF NOT EXISTS idx_stocks_sku_location
  ON public.stocks (sku, location_id);
CREATE INDEX IF NOT EXISTS idx_stocks_warehouse_status
  ON public.stocks (warehouse, status);

CREATE TABLE IF NOT EXISTS public.products (
  id text PRIMARY KEY,
  title text NOT NULL,
  shopify_product_id text NOT NULL,
  shopify_store text,
  vendor text,
  product_type text,
  tags text,
  status text,
  variant_count integer NOT NULL DEFAULT 0,
  sku_count integer NOT NULL DEFAULT 0,
  d365_sync_status text,
  gps_sync_status text,
  d365_result jsonb,
  gps_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id
  ON public.products (shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON public.products (status);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON public.products (vendor);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'orders', 'order_lines', 'inventory', 'sku_mappings',
    'sku_mapping_audit_log', 'user_preferences', 'locations', 'stocks', 'products'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = table_name || '_service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        table_name || '_service_role_all',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS battle_platform_orders_updated_at ON public.orders;
CREATE TRIGGER battle_platform_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_order_lines_updated_at ON public.order_lines;
CREATE TRIGGER battle_platform_order_lines_updated_at
  BEFORE UPDATE ON public.order_lines
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_inventory_updated_at ON public.inventory;
CREATE TRIGGER battle_platform_inventory_updated_at
  BEFORE UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_sku_mappings_updated_at ON public.sku_mappings;
CREATE TRIGGER battle_platform_sku_mappings_updated_at
  BEFORE UPDATE ON public.sku_mappings
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER battle_platform_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_locations_updated_at ON public.locations;
CREATE TRIGGER battle_platform_locations_updated_at
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_stocks_updated_at ON public.stocks;
CREATE TRIGGER battle_platform_stocks_updated_at
  BEFORE UPDATE ON public.stocks
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_products_updated_at ON public.products;
CREATE TRIGGER battle_platform_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DO $$
DECLARE
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH table_name IN ARRAY ARRAY['orders', 'inventory', 'locations', 'stocks', 'products']
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = table_name
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
      END IF;
    END LOOP;
  END IF;
END
$$;

COMMENT ON TABLE public.orders IS
  'Shared Shopify, D365, and warehouse order lifecycle state.';
COMMENT ON TABLE public.order_lines IS
  'D365 order lines persisted for idempotent fulfillment and refund replay.';
COMMENT ON COLUMN public.locations.country_data_area_mapping IS
  'Per-country D365 data-area overrides: [{"country":"US","dataAreaId":"U001"}].';

COMMIT;
