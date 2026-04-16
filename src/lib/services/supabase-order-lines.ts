// ============================================================================
// SUPABASE ORDER LINES SERVICE
// ============================================================================
// Persists D365 sales order lines (product + service) to Supabase so that
// fulfillment can replay shipping/tax lines to Dynamics without reconstructing
// them from Shopify data at fulfillment time.
//
// Mirrors spock-store's salesorderline entity pattern.
// Synthetic shopify_line_item_id values:
//   'shipping' → shipping cost line
//   'tax'      → combined tax + duty line
//   any other  → real Shopify line_item.id

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SHOPIFY_SHIPPING_LINE_ITEM_ID = "shipping";
export const SHOPIFY_TAX_LINE_ITEM_ID = "tax";

// ============================================================================
// Types
// ============================================================================

export interface OrderLineRecord {
  shopify_order_id: string;
  shopify_order_name?: string | null;
  /** Shopify line_item.id, or synthetic 'shipping' / 'tax' */
  shopify_line_item_id: string;
  shopify_sku?: string | null;
  d365_item_number: string;
  d365_sales_order_number?: string | null;
  data_area_id?: string | null;
  quantity: number;
  price?: number | null;
  dynamics_inventory_lot_id?: string | null;
  is_service_line: boolean;
}

export interface SavedOrderLine extends OrderLineRecord {
  id: string;
  is_fulfilled_to_dynamics: boolean;
  fulfilled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of `saveOrderLines` — use in Inngest step output / flow logs. */
export type SaveOrderLinesResult =
  | { ok: true; upsertedRowCount: number }
  | { ok: false; reason: "no_supabase_client" }
  | { ok: false; reason: "empty_input" }
  | { ok: false; reason: "supabase_error"; message: string; attemptedRowCount: number };

// ============================================================================
// Client
// ============================================================================

let _client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  _client =
    url && key
      ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
      : null;
  if (!_client) {
    console.warn(
      "[OrderLines] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — order line persistence disabled"
    );
  }
  return _client;
}

// ============================================================================
// Write
// ============================================================================

/**
 * Persist all D365 sales order lines (product + service) for a Shopify order.
 * Upserts on (shopify_order_id, shopify_line_item_id) so re-runs are idempotent.
 */
export async function saveOrderLines(lines: OrderLineRecord[]): Promise<SaveOrderLinesResult> {
  const supabase = getClient();
  if (!supabase) {
    return { ok: false, reason: "no_supabase_client" };
  }
  if (lines.length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  const { error } = await supabase
    .from("order_lines" as any)
    .upsert(
      lines.map((l) => ({
        shopify_order_id: l.shopify_order_id,
        shopify_order_name: l.shopify_order_name ?? null,
        shopify_line_item_id: l.shopify_line_item_id,
        shopify_sku: l.shopify_sku ?? null,
        d365_item_number: l.d365_item_number,
        d365_sales_order_number: l.d365_sales_order_number ?? null,
        data_area_id: l.data_area_id ?? null,
        quantity: l.quantity,
        price: l.price ?? null,
        dynamics_inventory_lot_id: l.dynamics_inventory_lot_id ?? null,
        is_service_line: l.is_service_line,
      })),
      { onConflict: "shopify_order_id,shopify_line_item_id", ignoreDuplicates: false }
    );

  if (error) {
    console.warn(
      `[OrderLines] Failed to save ${lines.length} lines for order ${lines[0]?.shopify_order_name ?? lines[0]?.shopify_order_id}: ${error.message}`
    );
    return {
      ok: false,
      reason: "supabase_error",
      message: error.message,
      attemptedRowCount: lines.length,
    };
  }
  console.log(
    `[OrderLines] Saved ${lines.length} lines for ${lines[0]?.shopify_order_name ?? lines[0]?.shopify_order_id} (salesOrder=${lines[0]?.d365_sales_order_number})`
  );
  return { ok: true, upsertedRowCount: lines.length };
}

/**
 * Update the dynamics_inventory_lot_id on an existing order line.
 * Called after D365 returns InventoryLotId from createSalesOrderLine.
 */
export async function updateOrderLineLotId(
  shopifyOrderId: string,
  shopifyLineItemId: string,
  lotId: string
): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  if (!lotId) return;

  const { error } = await supabase
    .from("order_lines" as any)
    .update({ dynamics_inventory_lot_id: lotId })
    .eq("shopify_order_id", shopifyOrderId)
    .eq("shopify_line_item_id", shopifyLineItemId);

  if (error) {
    console.warn(
      `[OrderLines] Failed to update lot ID for ${shopifyOrderId}/${shopifyLineItemId}: ${error.message}`
    );
  }
}

// ============================================================================
// Read
// ============================================================================

/**
 * Fetch all order lines for a Shopify order, including service lines.
 */
export async function fetchOrderLines(
  shopifyOrderId: string,
  shopifyOrderName?: string | null
): Promise<SavedOrderLine[]> {
  const supabase = getClient();
  if (!supabase) return [];

  const nameVariants = shopifyOrderName
    ? [...new Set([shopifyOrderName.trim(), shopifyOrderName.trim().replace(/^#/, "")])]
    : [];

  // Try by order name first (faster, more reliable)
  if (nameVariants.length > 0) {
    const { data, error } = await supabase
      .from("order_lines" as any)
      .select("*")
      .in("shopify_order_name", nameVariants);
    if (!error && data && data.length > 0) return data as SavedOrderLine[];
  }

  // Fall back to numeric order id
  const { data, error } = await supabase
    .from("order_lines" as any)
    .select("*")
    .eq("shopify_order_id", String(shopifyOrderId));

  if (error) {
    console.warn(`[OrderLines] fetchOrderLines failed for ${shopifyOrderId}: ${error.message}`);
    return [];
  }
  return (data ?? []) as SavedOrderLine[];
}

/** IM8-SER-* / PRE-SER-* SKU prefixes — mirrors spock-store SERVICE_SKU_PREFIX */
const SERVICE_SKU_PREFIXES = ["IM8-SER-", "PRE-SER-"];

function isServiceItemNumber(itemNumber: string | null | undefined): boolean {
  if (!itemNumber) return false;
  const upper = itemNumber.toUpperCase();
  return SERVICE_SKU_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Map d365_item_number (uppercase) → lot id from persisted order_lines.
 * Merged into OData lot map so fulfillment uses the same lots captured at order creation.
 */
export function buildLotIdMapFromOrderLines(lines: SavedOrderLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const lot = String(l.dynamics_inventory_lot_id ?? "").trim();
    if (!lot) continue;
    const key = String(l.d365_item_number ?? "").trim().toUpperCase();
    if (!key) continue;
    if (!out[key]) out[key] = lot;
  }
  return out;
}

/** Prefer lot from the saved row for this Shopify fulfillment line_item.id */
export function getLotFromSavedOrderLineByShopifyLineItemId(
  lines: SavedOrderLine[],
  shopifyLineItemId: string
): string {
  if (!shopifyLineItemId) return "";
  const id = String(shopifyLineItemId);
  const row = lines.find(
    (l) =>
      l.shopify_line_item_id === id &&
      String(l.dynamics_inventory_lot_id ?? "").trim() !== ""
  );
  return row ? String(row.dynamics_inventory_lot_id).trim() : "";
}

export function filterUnfulfilledServiceLines(lines: SavedOrderLine[]): SavedOrderLine[] {
  return lines.filter(
    (l) =>
      (l.is_service_line || isServiceItemNumber(l.d365_item_number)) &&
      !l.is_fulfilled_to_dynamics
  );
}

/**
 * Fetch only the service lines (shipping + tax) that have NOT yet been
 * fulfilled to Dynamics. Returns [] if all service lines are already fulfilled
 * or if no service lines exist.
 *
 * Detection: is_service_line flag OR IM8-SER-/PRE-SER- prefix on d365_item_number
 * — mirrors spock-store's isServiceSkuLineItem (SKU pattern check).
 */
export async function fetchUnfulfilledServiceLines(
  shopifyOrderId: string,
  shopifyOrderName?: string | null
): Promise<SavedOrderLine[]> {
  const all = await fetchOrderLines(shopifyOrderId, shopifyOrderName);
  return filterUnfulfilledServiceLines(all);
}

/**
 * Mark service lines as fulfilled to Dynamics.
 * Called after a successful createFulfilment call that included service lines.
 */
export async function markServiceLinesFulfilled(
  shopifyOrderId: string,
  shopifyLineItemIds: string[]
): Promise<void> {
  const supabase = getClient();
  if (!supabase || shopifyLineItemIds.length === 0) return;

  const { error } = await supabase
    .from("order_lines" as any)
    .update({ is_fulfilled_to_dynamics: true, fulfilled_at: new Date().toISOString() })
    .eq("shopify_order_id", shopifyOrderId)
    .in("shopify_line_item_id", shopifyLineItemIds);

  if (error) {
    console.warn(
      `[OrderLines] Failed to mark service lines fulfilled for ${shopifyOrderId}: ${error.message}`
    );
  } else {
    console.log(
      `[OrderLines] Marked ${shopifyLineItemIds.length} service lines fulfilled for ${shopifyOrderId}: ${shopifyLineItemIds.join(", ")}`
    );
  }
}
