/**
 * Fulfilment/sync recovery lane routing (Hub reconciliation recovery mode).
 */

export type RecoveryLane =
  | "sync_shopify_recover"
  | "sync_order_paid"
  | "gps_fulfilment"
  | "stord_fulfilment"
  | "dynamics_shopify_mirror"
  | "skipped";

export type HubOrderRecoveryRow = {
  shopify_order_name?: string | null;
  shopify_order_id?: string | null;
  warehouse?: string | null;
  d365_order_number?: string | null;
  gps_order_no?: string | null;
  gps_uk_order_no?: string | null;
  shopify_fulfillment_status?: string | null;
  gps_sync_status?: string | null;
};

const GPS_WAREHOUSES = new Set(["GPS Warehouse", "GPS UK Warehouse"]);

function isGpsWarehouse(warehouse: string | null | undefined): boolean {
  const w = String(warehouse || "").trim();
  return GPS_WAREHOUSES.has(w) || w.toUpperCase().includes("GPS");
}

function isStordWarehouse(warehouse: string | null | undefined): boolean {
  return String(warehouse || "")
    .toUpperCase()
    .includes("STORD");
}

function isHkOrDynamicsWarehouse(warehouse: string | null | undefined): boolean {
  const w = String(warehouse || "").trim();
  return w === "HK Warehouse" || w.toUpperCase().includes("H007");
}

export function hubShowsFulfillmentPresent(
  shopifyFulfillmentStatus: string | null | undefined
): boolean {
  const s = String(shopifyFulfillmentStatus || "").toLowerCase().trim();
  return (
    s === "fulfilled" ||
    s === "partial" ||
    s === "synced" ||
    s === "completed"
  );
}

export function resolveSyncLane(
  row: HubOrderRecoveryRow | null,
  orderName: string
): { lane: RecoveryLane; reason?: string } {
  if (!row) {
    return { lane: "sync_shopify_recover", reason: "order_missing_in_hub" };
  }
  const d365 = String(row.d365_order_number || "").trim();
  if (!d365) {
    return { lane: "sync_order_paid", reason: "missing_d365_sales_order" };
  }
  return { lane: "skipped", reason: "sync_already_ok" };
}

export function resolveFulfilmentLane(
  row: HubOrderRecoveryRow | null,
  orderName: string,
  options?: {
    /** When true, prefer DB→Shopify mirror (fulfillment recon DB→Shopify bucket). */
    preferDbToShopify?: boolean;
    /** When true, prefer Shopify→DB replay (fulfillment recon Shopify→DB bucket). */
    preferShopifyToDb?: boolean;
  }
): { lane: RecoveryLane; reason?: string } {
  if (!row) {
    return { lane: "skipped", reason: "order_not_found_in_hub" };
  }

  if (hubShowsFulfillmentPresent(row.shopify_fulfillment_status)) {
    const d365 = String(row.d365_order_number || "").trim();
    if (d365) {
      return { lane: "skipped", reason: "already_synced" };
    }
    if (isGpsWarehouse(row.warehouse)) {
      return { lane: "gps_fulfilment", reason: "hub_fulfilled_gps_needs_d365" };
    }
    return { lane: "stord_fulfilment", reason: "hub_fulfilled_needs_d365_replay" };
  }

  if (options?.preferDbToShopify || isHkOrDynamicsWarehouse(row.warehouse)) {
    return { lane: "dynamics_shopify_mirror", reason: "dynamics_to_shopify_gap" };
  }

  if (isGpsWarehouse(row.warehouse)) {
    const hasGpsId =
      String(row.gps_order_no || "").trim() || String(row.gps_uk_order_no || "").trim();
    if (!hasGpsId) {
      return { lane: "skipped", reason: "gps_no_outbound_id" };
    }
    return { lane: "gps_fulfilment" };
  }

  if (isStordWarehouse(row.warehouse) || options?.preferShopifyToDb) {
    return { lane: "stord_fulfilment" };
  }

  return { lane: "stord_fulfilment", reason: "default_shopify_to_db_replay" };
}

export function resolveGpsOutboundFromRow(row: HubOrderRecoveryRow): {
  outboundId: string;
  warehouseName: "GPS Warehouse" | "GPS UK Warehouse";
} | null {
  const warehouse = String(row.warehouse || "").trim();
  if (warehouse === "GPS UK Warehouse") {
    const id = String(row.gps_uk_order_no || row.gps_order_no || "").trim();
    return id ? { outboundId: id, warehouseName: "GPS UK Warehouse" } : null;
  }
  if (warehouse === "GPS Warehouse") {
    const id = String(row.gps_order_no || row.gps_uk_order_no || "").trim();
    return id ? { outboundId: id, warehouseName: "GPS Warehouse" } : null;
  }
  const uk = String(row.gps_uk_order_no || "").trim();
  if (uk) return { outboundId: uk, warehouseName: "GPS UK Warehouse" };
  const us = String(row.gps_order_no || "").trim();
  if (us) return { outboundId: us, warehouseName: "GPS Warehouse" };
  return null;
}
