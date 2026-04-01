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

/** Resolve numeric Shopify order id → row with D365 SO number if Hub has synced it. */
export async function fetchD365HintByShopifyOrderId(
  shopifyOrderId: string
): Promise<SupabaseOrderD365Hint | null> {
  const supabase = getClient();
  if (!supabase || !shopifyOrderId) return null;

  const { data, error } = await supabase
    .from("orders")
    .select("d365_order_number, warehouse")
    .eq("shopify_order_id", String(shopifyOrderId).trim())
    .not("d365_order_number", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[SupabaseOrderLookup] query failed for shopify_order_id=${shopifyOrderId}: ${error.message}`);
    return null;
  }
  if (!data?.d365_order_number || typeof data.d365_order_number !== "string") {
    return null;
  }

  return {
    d365OrderNumber: data.d365_order_number.trim(),
    warehouse: typeof data.warehouse === "string" ? data.warehouse : null,
  };
}
