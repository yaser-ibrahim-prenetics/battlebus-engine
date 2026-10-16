import * as gpsInventory from "../../clients/gps-inventory";
import type { InventoryLevel } from "./types";
import { getWarehouseMapping } from "./warehouse-mappings";

/** Query GPS inventory levels aggregated across the selected region. */
export async function queryGpsInventory(
  skus: string[],
  region: "US" | "UK" = "UK"
): Promise<Map<string, InventoryLevel>> {
  console.log(`[InventorySync] Querying GPS inventory for ${skus.length} SKUs`);

  const snapshot = await gpsInventory.getInventorySnapshot(skus, region);
  const result = new Map<string, InventoryLevel>();

  for (const [sku, levels] of snapshot) {
    result.set(sku, {
      sku,
      available: levels.available,
      reserved: levels.reserved,
      inTransit: levels.inTransit,
      lastUpdated: new Date(),
    });
  }

  return result;
}

/** Query GPS inventory for a single configured warehouse. */
export async function queryGpsWarehouseInventory(
  warehouseName: string,
  skus?: string[]
): Promise<Map<string, InventoryLevel>> {
  console.log(`[InventorySync] Querying GPS inventory for warehouse: ${warehouseName}`);

  const mapping = await getWarehouseMapping(warehouseName);
  if (!mapping) {
    throw new Error(`Unknown warehouse: ${warehouseName}`);
  }

  const region = warehouseName.includes("UK") ? "UK" : "US";
  const items = await gpsInventory.queryProductInventory({ region, skus: skus || [] });
  const result = new Map<string, InventoryLevel>();

  for (const item of items) {
    const sku = item.sku;
    if (skus && skus.length > 0 && !skus.includes(sku)) continue;

    result.set(sku, {
      sku,
      available: item.availableQty || 0,
      reserved: item.lockedQty || 0,
      inTransit: item.transitQty || 0,
      lastUpdated: new Date(),
    });
  }

  console.log(`[InventorySync] Found ${result.size} inventory items for ${warehouseName}`);
  return result;
}
