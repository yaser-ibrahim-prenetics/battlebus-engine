// ============================================================================
// POSTGRESQL ORDER LINES SERVICE
// ============================================================================
// Persists D365 sales order lines (product + service) to Cloud SQL so that
// fulfillment can replay shipping/tax lines to Dynamics without reconstructing
// them from Shopify data at fulfillment time.
//
// Mirrors spock-store's salesorderline entity pattern.
// Synthetic shopify_line_item_id values:
//   'shipping' → shipping cost line
//   'tax'      → combined tax + duty line
//   any other  → real Shopify line_item.id

import {
  isDatabaseConfigured,
  queryDatabase,
  quoteIdentifier,
} from "@/lib/db/database";

export const SHOPIFY_SHIPPING_LINE_ITEM_ID = "shipping";
export const SHOPIFY_TAX_LINE_ITEM_ID = "tax";

/** Synthetic prefix for refund lines: `refund:<refundId>`. */
export const REFUND_LINE_ITEM_ID_PREFIX = "refund:";

/** Build the synthetic `shopify_line_item_id` used for a refund row. */
export function buildRefundLineItemId(refundId: string | number): string {
  return `${REFUND_LINE_ITEM_ID_PREFIX}${refundId}`;
}

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
  | { ok: false; reason: "no_database_client" }
  | { ok: false; reason: "empty_input" }
  | { ok: false; reason: "database_error"; message: string; attemptedRowCount: number };

// ============================================================================
// Database helpers
// ============================================================================

function databaseAvailable(): boolean {
  const available = isDatabaseConfigured();
  if (!available) {
    console.warn("[OrderLines] PostgreSQL is not configured — order line persistence disabled");
  }
  return available;
}

async function upsertRows(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const values = rows.flatMap((row) => columns.map((column) => row[column]));
  const tuples = rows.map((_, rowIndex) => {
    const offset = rowIndex * columns.length;
    return `(${columns.map((__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });
  const updates = columns
    .filter((column) => !["shopify_order_id", "shopify_line_item_id"].includes(column))
    .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
    .join(", ");
  await queryDatabase(
    `INSERT INTO public.order_lines (${columns.map(quoteIdentifier).join(", ")})
     VALUES ${tuples.join(", ")}
     ON CONFLICT (shopify_order_id, shopify_line_item_id)
     DO UPDATE SET ${updates}`,
    values
  );
}

// ============================================================================
// Write
// ============================================================================

/**
 * Persist all D365 sales order lines (product + service) for a Shopify order.
 * Upserts on (shopify_order_id, shopify_line_item_id) so re-runs are idempotent.
 */
export async function saveOrderLines(lines: OrderLineRecord[]): Promise<SaveOrderLinesResult> {
  if (!databaseAvailable()) {
    return { ok: false, reason: "no_database_client" };
  }
  if (lines.length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  try {
    await upsertRows(
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
      }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[OrderLines] Failed to save ${lines.length} lines for order ${lines[0]?.shopify_order_name ?? lines[0]?.shopify_order_id}: ${message}`
    );
    return {
      ok: false,
      reason: "database_error",
      message,
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
  if (!databaseAvailable()) return;
  if (!lotId) return;

  try {
    await queryDatabase(
      `UPDATE public.order_lines SET dynamics_inventory_lot_id = $3
       WHERE shopify_order_id = $1 AND shopify_line_item_id = $2`,
      [shopifyOrderId, shopifyLineItemId, lotId]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[OrderLines] Failed to update lot ID for ${shopifyOrderId}/${shopifyLineItemId}: ${message}`
    );
  }
}

// ============================================================================
// Refund lines
// ============================================================================

export interface RefundOrderLineRecord {
  shopify_order_id: string;
  shopify_order_name?: string | null;
  /** Shopify refund.id (Numeric-ish string). Used to build the synthetic line item id. */
  refund_id: string;
  /** D365 refund service SKU (e.g. IM8-SER-000005). */
  refund_sku: string;
  d365_sales_order_number?: string | null;
  data_area_id?: string | null;
  /** Refund amount in the D365 posting currency (USD). Persisted as a positive price; quantity is -1. */
  refund_amount_usd: number;
  dynamics_inventory_lot_id?: string | null;
  /** True once the `type: "return"` fulfilment has been posted to D365. */
  is_fulfilled_to_dynamics?: boolean;
  credit_note_number?: string | null;
  exchange_rate?: number | null;
  exchange_rate_source?: string | null;
  /** Original Shopify presentment currency (pre-USD conversion). */
  source_currency?: string | null;
}

export type SaveRefundOrderLineResult =
  | { ok: true; degraded?: boolean }
  | { ok: false; reason: "no_database_client" }
  | { ok: false; reason: "database_error"; message: string };

/**
 * Persist a single D365 refund line to `order_lines` so the Hub can render it
 * next to the product / service lines. Upserts on
 * `(shopify_order_id, shopify_line_item_id)` with a synthetic
 * `shopify_line_item_id = "refund:<refundId>"` for idempotency across retries
 * (same refund event) and races (Hub-triggered refund + Shopify webhook for
 * the same refundId).
 *
 * Best-effort: if the hub has not yet run migration 019 the extended columns
 * won't exist and PostgreSQL will report an undefined column. In that case we retry with only the base
 * (pre-019) columns so refunds still show up in the UI, just without the
 * extra metadata.
 */
export async function saveRefundOrderLine(
  record: RefundOrderLineRecord
): Promise<SaveRefundOrderLineResult> {
  if (!databaseAvailable()) return { ok: false, reason: "no_database_client" };

  const refundId = String(record.refund_id || "").trim();
  if (!refundId) {
    return {
      ok: false,
      reason: "database_error",
      message: "saveRefundOrderLine: missing refund_id",
    };
  }

  const lineItemId = buildRefundLineItemId(refundId);
  const fulfilled = Boolean(record.is_fulfilled_to_dynamics);

  const baseRow = {
    shopify_order_id: record.shopify_order_id,
    shopify_order_name: record.shopify_order_name ?? null,
    shopify_line_item_id: lineItemId,
    shopify_sku: record.refund_sku,
    d365_item_number: record.refund_sku,
    d365_sales_order_number: record.d365_sales_order_number ?? null,
    data_area_id: record.data_area_id ?? null,
    quantity: -1,
    price: record.refund_amount_usd,
    dynamics_inventory_lot_id: record.dynamics_inventory_lot_id ?? null,
    is_service_line: true,
    is_fulfilled_to_dynamics: fulfilled,
    fulfilled_at: fulfilled ? new Date().toISOString() : null,
  } as const;

  const extendedRow = {
    ...baseRow,
    refund_id: refundId,
    credit_note_number: record.credit_note_number ?? null,
    exchange_rate: record.exchange_rate ?? null,
    exchange_rate_source: record.exchange_rate_source ?? null,
    source_currency: record.source_currency ?? null,
  } as const;

  try {
    await upsertRows([extendedRow]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error && "code" in error ? error.code : null;
    if (code !== "42703" && !/column .* does not exist/i.test(message)) {
      console.warn(`[OrderLines] Failed to save refund line ${refundId}: ${message}`);
      return { ok: false, reason: "database_error", message };
    }
    console.warn(
      `[OrderLines] Refund line extended columns missing (hub migration 019 not applied?). ` +
        `Retrying with base columns only for refund ${refundId}: ${message}`
    );
    try {
      await upsertRows([baseRow]);
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      console.warn(
        `[OrderLines] Failed to save refund line ${refundId} (base-only retry): ${retryMessage}`
      );
      return { ok: false, reason: "database_error", message: retryMessage };
    }
    console.log(
      `[OrderLines] Saved refund line ${refundId} (base columns only — run hub migration 019 to persist FX + credit note)`
    );
    return { ok: true, degraded: true };
  }

  console.log(
    `[OrderLines] Saved refund line ${refundId} (${record.refund_sku} x -1 @ ${record.refund_amount_usd} USD, ` +
      `lot=${record.dynamics_inventory_lot_id ?? "n/a"}, creditNote=${record.credit_note_number ?? "n/a"})`
  );
  return { ok: true };
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
  if (!databaseAvailable()) return [];

  const nameVariants = shopifyOrderName
    ? [...new Set([shopifyOrderName.trim(), shopifyOrderName.trim().replace(/^#/, "")])]
    : [];

  // Try by order name first (faster, more reliable)
  if (nameVariants.length > 0) {
    const byName = await queryDatabase<SavedOrderLine>(
      `SELECT * FROM public.order_lines WHERE shopify_order_name = ANY($1::text[])`,
      [nameVariants]
    );
    if (byName.rows.length > 0) return byName.rows;
  }

  // Fall back to numeric order id
  try {
    const result = await queryDatabase<SavedOrderLine>(
      `SELECT * FROM public.order_lines WHERE shopify_order_id = $1`,
      [String(shopifyOrderId)]
    );
    return result.rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[OrderLines] fetchOrderLines failed for ${shopifyOrderId}: ${message}`);
    return [];
  }
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
    const key = String(l.d365_item_number ?? "")
      .trim()
      .toUpperCase();
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
    (l) => l.shopify_line_item_id === id && String(l.dynamics_inventory_lot_id ?? "").trim() !== ""
  );
  return row ? String(row.dynamics_inventory_lot_id).trim() : "";
}

/** Synthetic Hub refund rows use `shopify_line_item_id` `refund:<refundId>` — never ship these on product fulfilment. */
function isRefundSyntheticOrderLine(l: SavedOrderLine): boolean {
  return String(l.shopify_line_item_id || "").startsWith(REFUND_LINE_ITEM_ID_PREFIX);
}

export function filterUnfulfilledServiceLines(lines: SavedOrderLine[]): SavedOrderLine[] {
  return lines.filter(
    (l) =>
      !isRefundSyntheticOrderLine(l) &&
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
  if (!databaseAvailable() || shopifyLineItemIds.length === 0) return;
  try {
    await queryDatabase(
      `UPDATE public.order_lines
       SET is_fulfilled_to_dynamics = true, fulfilled_at = now()
       WHERE shopify_order_id = $1 AND shopify_line_item_id = ANY($2::text[])`,
      [shopifyOrderId, shopifyLineItemIds]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[OrderLines] Failed to mark service lines fulfilled for ${shopifyOrderId}: ${message}`
    );
    return;
  }
  console.log(
    `[OrderLines] Marked ${shopifyLineItemIds.length} service lines fulfilled for ${shopifyOrderId}: ${shopifyLineItemIds.join(", ")}`
  );
}
