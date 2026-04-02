/**
 * Read order metadata from Hub Supabase (service role) for Inngest fallbacks
 * when Dynamics OData lookups by Shopify reference miss.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  _client =
    url && key
      ? createClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
  if (!_client) {
    console.warn(
      "[SupabaseOrderLookup] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — D365 fallback from DB disabled"
    );
  }
  return _client;
}

export type SupabaseOrderD365Hint = {
  d365OrderNumber: string;
  warehouse: string | null;
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
  const supabase = getClient();
  if (!supabase) return null;

  const base = () =>
    supabase
      .from("orders")
      .select("d365_order_number, warehouse")
      .not("d365_order_number", "is", null);

  for (const v of shopifyNameLookupVariants(shopifyOrderName)) {
    for (const column of ["shopify_order_name", "order_number", "id"] as const) {
      const { data, error } = await base().eq(column, v).limit(1).maybeSingle();
      if (error) {
        console.warn(
          `[SupabaseOrderLookup] ${column}=${v} query failed: ${error.message}`
        );
        continue;
      }
      const hint = rowToHint(data ?? null);
      if (hint) {
        console.log(`[SupabaseOrderLookup] Matched by ${column}=${v} → d365_order_number`);
        return hint;
      }
    }
  }

  const id = String(shopifyOrderId || "").trim();
  if (!id) return null;

  const { data: byId, error: errId } = await base()
    .or(`shopify_order_id.eq.${id},platform_order_id.eq.${id}`)
    .limit(1)
    .maybeSingle();

  if (errId) {
    console.warn(`[SupabaseOrderLookup] id query failed for id=${id}: ${errId.message}`);
  }
  return rowToHint(byId ?? null);
}

/**
 * Hub `orders.state.d365InventoryLotsBySku` — captured at D365 line creation (spock-store parity).
 * Used to resolve Lotid when OData SalesOrderLines lags or SKUs differ from current Shopify fulfillment lines.
 */
export async function fetchD365InventoryLotsByShopifyOrder(
  shopifyOrderId: string,
  shopifyOrderName?: string | null
): Promise<Record<string, string> | null> {
  const supabase = getClient();
  if (!supabase) return null;

  const base = () =>
    supabase.from("orders").select("state").not("state", "is", null);

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

  for (const v of shopifyNameLookupVariants(shopifyOrderName)) {
    for (const column of ["shopify_order_name", "order_number", "id"] as const) {
      const { data, error } = await base().eq(column, v).limit(1).maybeSingle();
      if (error) {
        console.warn(
          `[SupabaseOrderLookup] state fetch ${column}=${v} failed: ${error.message}`
        );
        continue;
      }
      const lots = extractLots(data ?? null);
      if (lots) {
        console.log(
          `[SupabaseOrderLookup] d365InventoryLotsBySku from ${column}=${v} (${Object.keys(lots).length} SKUs)`
        );
        return lots;
      }
    }
  }

  const id = String(shopifyOrderId || "").trim();
  if (!id) return null;

  const { data: byId, error: errId } = await base()
    .or(`shopify_order_id.eq.${id},platform_order_id.eq.${id}`)
    .limit(1)
    .maybeSingle();

  if (errId) {
    console.warn(`[SupabaseOrderLookup] state fetch by id failed for id=${id}: ${errId.message}`);
  }
  return extractLots(byId ?? null);
}
