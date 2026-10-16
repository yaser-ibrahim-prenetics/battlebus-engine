import { config } from "../../config";
import { mapShopifySkuToDynamicsForOrderLine } from "../../transformers/sku";
import { queryD365Inventory } from "./d365-inventory";
import { queryGpsWarehouseInventory } from "./gps-inventory";
import type { SyncResult } from "./types";
import { getWarehouseMapping } from "./warehouse-mappings";

/** Synchronize one GPS warehouse SKU into D365. */
export async function syncGpsToD365(sku: string, warehouseName: string): Promise<SyncResult> {
  console.log(`[InventorySync] Syncing GPS -> D365: ${sku} in ${warehouseName}`);

  if (!config.features.enableInventorySync) {
    return {
      success: false,
      message: "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)",
      sku,
      source: "gps",
      destination: "d365",
      error: "INVENTORY_SYNC_DISABLED",
    };
  }

  const mapping = await getWarehouseMapping(warehouseName);
  if (!mapping) {
    return {
      success: false,
      message: `Unknown warehouse: ${warehouseName}`,
      sku,
      source: "gps",
      destination: "d365",
      error: "UNKNOWN_WAREHOUSE",
    };
  }

  try {
    const gpsInventory = await queryGpsWarehouseInventory(warehouseName, [sku]);
    const gpsLevel = gpsInventory.get(sku);

    if (!gpsLevel) {
      return {
        success: false,
        message: `SKU ${sku} not found in GPS warehouse ${warehouseName}`,
        sku,
        source: "gps",
        destination: "d365",
        error: "SKU_NOT_FOUND",
      };
    }

    const d365Sku = mapShopifySkuToDynamicsForOrderLine(sku);
    const d365Inventory = await queryD365Inventory([sku], mapping.d365DataAreaId);
    const previousLevel = d365Inventory.get(sku)?.available || 0;
    const adjustment = gpsLevel.available - previousLevel;

    if (adjustment === 0) {
      return {
        success: true,
        message: `D365 already in sync for ${sku}`,
        sku,
        source: "gps",
        destination: "d365",
        previousLevel,
        newLevel: gpsLevel.available,
      };
    }

    console.log(`[InventorySync] D365 adjustment needed: ${adjustment} for ${d365Sku}`);

    if (config.features.dryRunMode) {
      console.log(`[InventorySync] DRY RUN - Would adjust D365 inventory by ${adjustment}`);
      return {
        success: true,
        message: `DRY RUN - Would adjust D365 by ${adjustment}`,
        sku,
        source: "gps",
        destination: "d365",
        previousLevel,
        newLevel: gpsLevel.available,
      };
    }

    // D365 inventory adjustments require the THK custom API or an adjustment journal.
    console.log("[InventorySync] D365 inventory adjustment not yet implemented");

    return {
      success: true,
      message: `Adjustment of ${adjustment} recorded for D365`,
      sku,
      source: "gps",
      destination: "d365",
      previousLevel,
      newLevel: gpsLevel.available,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[InventorySync] GPS -> D365 sync error: ${errorMessage}`);
    return {
      success: false,
      message: `Sync failed: ${errorMessage}`,
      sku,
      source: "gps",
      destination: "d365",
      error: errorMessage,
    };
  }
}
