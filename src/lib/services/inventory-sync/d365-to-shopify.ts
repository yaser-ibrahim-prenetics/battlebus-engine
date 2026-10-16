import * as shopify from "../../clients/shopify";
import { config } from "../../config";
import { queryD365Inventory } from "./d365-inventory";
import { queryShopifyInventory } from "./shopify-inventory";
import type { SyncResult } from "./types";
import { getWarehouseMappings } from "./warehouse-mappings";

/** Synchronize one D365 SKU into its mapped Shopify location. */
export async function syncD365ToShopify(
  sku: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<SyncResult> {
  console.log(`[InventorySync] Syncing D365 -> Shopify: ${sku}`);

  if (!config.features.enableInventorySync) {
    return {
      success: false,
      message: "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)",
      sku,
      source: "d365",
      destination: "shopify",
      error: "INVENTORY_SYNC_DISABLED",
    };
  }

  try {
    const d365Inventory = await queryD365Inventory([sku], dataAreaId);
    const d365Level = d365Inventory.get(sku);

    if (!d365Level) {
      return {
        success: false,
        message: `SKU ${sku} not found in D365`,
        sku,
        source: "d365",
        destination: "shopify",
        error: "SKU_NOT_FOUND",
      };
    }

    const warehouseMappings = await getWarehouseMappings();
    const warehouseMapping = warehouseMappings.find(
      (mapping) => mapping.d365DataAreaId === dataAreaId
    );
    const locationId = warehouseMapping?.shopifyLocationId;

    const shopifyInventory = await queryShopifyInventory([sku], locationId);
    const previousLevel = shopifyInventory.get(sku)?.available || 0;
    const adjustment = d365Level.available - previousLevel;

    if (adjustment === 0) {
      return {
        success: true,
        message: `Shopify already in sync for ${sku}`,
        sku,
        source: "d365",
        destination: "shopify",
        previousLevel,
        newLevel: d365Level.available,
      };
    }

    console.log(`[InventorySync] Shopify adjustment needed: ${adjustment} for ${sku}`);

    if (config.features.dryRunMode) {
      console.log(`[InventorySync] DRY RUN - Would adjust Shopify inventory by ${adjustment}`);
      return {
        success: true,
        message: `DRY RUN - Would adjust Shopify by ${adjustment}`,
        sku,
        source: "d365",
        destination: "shopify",
        previousLevel,
        newLevel: d365Level.available,
      };
    }

    if (!locationId) {
      throw new Error(`No Shopify location is mapped to D365 data area ${dataAreaId}`);
    }

    const updated = await shopify.setSkuInventoryAtLocation({
      sku,
      locationId,
      quantity: d365Level.available,
      referenceDocumentUri: `gid://battle-bus/D365Inventory/${encodeURIComponent(dataAreaId)}-${encodeURIComponent(sku)}`,
    });

    return {
      success: true,
      message: `Set ${updated.updated} Shopify variant(s) to ${d365Level.available}`,
      sku,
      source: "d365",
      destination: "shopify",
      previousLevel,
      newLevel: d365Level.available,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[InventorySync] D365 -> Shopify sync error: ${errorMessage}`);
    return {
      success: false,
      message: `Sync failed: ${errorMessage}`,
      sku,
      source: "d365",
      destination: "shopify",
      error: errorMessage,
    };
  }
}
