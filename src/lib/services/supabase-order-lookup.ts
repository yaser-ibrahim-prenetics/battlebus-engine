/**
 * Read order metadata from Cloud SQL for Inngest fallbacks
 * when Dynamics OData lookups by Shopify reference miss.
 */
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

function databaseAvailable(): boolean {
  const available = isDatabaseConfigured();
  if (!available) {
    console.warn("[OrderLookup] PostgreSQL is not configured — D365 fallback from DB disabled");
  }
  return available;
}

export type SupabaseOrderD365Hint = {
  d365OrderNumber: string;
  warehouse: string | null;
};

export type GpsRecoveryOrderContext = {
  shopifyOrderName: string;
  shopifyOrderId: string | null;
  warehouse: string | null;
  gpsOrderNo: string | null;
  gpsUkOrderNo: string | null;
  shopifyFulfillmentStatus: string | null;
  d365OrderNumber: string | null;
};

function rowToHint(data: Record<string, unknown> | null | undefined): SupabaseOrderD365Hint | null {
  if (!data?.d365_order_number || typeof data.d365_order_number !== "string") {
    return null;
  }
  const num = data.d365_order_number.trim();
  if (!num) return null;
  return {
    d365OrderNumber: num,
    warehouse: typeof data.warehouse === "string" ? data.warehouse : null,
  };
}

/** `#IM8-1`, `IM8-1`, etc. — Hub often keys `id` / `order_number` by order name. */
function shopifyNameLookupVariants(name: string | null | undefined): string[] {
  if (!name || typeof name !== "string") return [];
  const t = name.trim();
  if (!t) return [];
  const stripped = t.replace(/^#/, "").trim();
  if (!stripped) return [];
  return [...new Set([t, stripped, `#${stripped}`])];
}

/**
 * Hub `orders` row → D365 sales order number + warehouse.
 * Tries **Shopify order name first** (shopify_order_name / order_number / id — Hub keys by name),
 * then numeric Shopify id (shopify_order_id | platform_order_id).
 */
export async function fetchD365HintByShopifyOrderId(
  shopifyOrderId: string,
  shopifyOrderName?: string | null
): Promise<SupabaseOrderD365Hint | null> {
  if (!databaseAvailable()) return null;

  const variants = shopifyNameLookupVariants(shopifyOrderName);
  if (variants.length > 0) {
    const byName = await queryDatabase(
      `SELECT d365_order_number, warehouse
       FROM public.orders
       WHERE d365_order_number IS NOT NULL
         AND (shopify_order_name = ANY($1::text[]) OR order_number = ANY($1::text[]) OR id = ANY($1::text[]))
       LIMIT 1`,
      [variants]
    );
    const hint = rowToHint(byName.rows[0] ?? null);
    if (hint) return hint;
  }

  const id = String(shopifyOrderId || "").trim();
  if (!id) return null;

  const byId = await queryDatabase(
    `SELECT d365_order_number, warehouse
     FROM public.orders
     WHERE d365_order_number IS NOT NULL
       AND (shopify_order_id = $1 OR platform_order_id = $1)
     LIMIT 1`,
    [id]
  );
  return rowToHint(byId.rows[0] ?? null);
}

/**
 * Hub `orders.state.d365InventoryLotsBySku` — captured at D365 line creation (spock-store parity).
 * Used to resolve Lotid when OData SalesOrderLines lags or SKUs differ from current Shopify fulfillment lines.
 */
export async function fetchD365InventoryLotsByShopifyOrder(
  shopifyOrderId: string,
  shopifyOrderName?: string | null
): Promise<Record<string, string> | null> {
  if (!databaseAvailable()) return null;

  const extractLots = (row: Record<string, unknown> | null): Record<string, string> | null => {
    const state = row?.state as Record<string, unknown> | null | undefined;
    const raw = state?.d365InventoryLotsBySku;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k).trim().toUpperCase();
      const val = String(v ?? "").trim();
      if (key && val) out[key] = val;
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const variants = shopifyNameLookupVariants(shopifyOrderName);
  if (variants.length > 0) {
    const byName = await queryDatabase(
      `SELECT state
       FROM public.orders
       WHERE state IS NOT NULL
         AND (shopify_order_name = ANY($1::text[]) OR order_number = ANY($1::text[]) OR id = ANY($1::text[]))
       LIMIT 1`,
      [variants]
    );
    const lots = extractLots(byName.rows[0] ?? null);
    if (lots) return lots;
  }

  const id = String(shopifyOrderId || "").trim();
  if (!id) return null;

  const byId = await queryDatabase(
    `SELECT state
     FROM public.orders
     WHERE state IS NOT NULL AND (shopify_order_id = $1 OR platform_order_id = $1)
     LIMIT 1`,
    [id]
  );
  return extractLots(byId.rows[0] ?? null);
}

/**
 * Hub order row for GPS fulfilment recovery (poll outbound detail by GPS id).
 */
export async function fetchGpsRecoveryContextByShopifyOrderName(
  shopifyOrderName: string
): Promise<GpsRecoveryOrderContext | null> {
  if (!databaseAvailable()) return null;
  const variants = shopifyNameLookupVariants(shopifyOrderName);
  if (variants.length === 0) return null;
  const result = await queryDatabase<Record<string, unknown>>(
    `SELECT shopify_order_name, shopify_order_id, warehouse, gps_order_no,
            gps_uk_order_no, shopify_fulfillment_status, d365_order_number
     FROM public.orders
     WHERE shopify_order_name = ANY($1::text[])
        OR order_number = ANY($1::text[])
        OR id = ANY($1::text[])
     LIMIT 1`,
    [variants]
  );
  const data = result.rows[0];
  if (!data) return null;
  return {
    shopifyOrderName: String(data.shopify_order_name || shopifyOrderName).trim(),
    shopifyOrderId: data.shopify_order_id ? String(data.shopify_order_id) : null,
    warehouse: typeof data.warehouse === "string" ? data.warehouse : null,
    gpsOrderNo: data.gps_order_no ? String(data.gps_order_no).trim() : null,
    gpsUkOrderNo: data.gps_uk_order_no ? String(data.gps_uk_order_no).trim() : null,
    shopifyFulfillmentStatus:
      typeof data.shopify_fulfillment_status === "string"
        ? data.shopify_fulfillment_status
        : null,
    d365OrderNumber:
      typeof data.d365_order_number === "string" ? data.d365_order_number.trim() : null,
  };
}
