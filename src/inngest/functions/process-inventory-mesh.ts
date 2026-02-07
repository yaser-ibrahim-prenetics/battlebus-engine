// ============================================================================
// INVENTORY SYNC MESH PROCESSOR
// ============================================================================
// Unified inventory sync function that routes inventory changes between platforms
// Supports: Shopify ↔ Dynamics ↔ GPS/Warehouse
//
// This acts as the "brain" that knows:
// - Where inventory is coming from (source)
// - Where it needs to go (destination)
// - How to transform data between platforms
// - Which warehouse/location to sync to

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

type Platform = "shopify" | "dynamics" | "gps" | "warehouse" | "stord" | "extensiv";

interface InventorySyncPayload {
  sku?: string;
  inventoryItemId?: string;
  variantId?: string;
  productId?: string;
  quantity?: number;
  available?: number;
  reserved?: number;
  committed?: number;
  locationId?: string | number;
  warehouseId?: string;
  warehouseName?: string;
  dataAreaId?: string;
  productTitle?: string;
  variantTitle?: string;
  barcode?: string;
  price?: string | number;
  weight?: number;
  weightUnit?: string;
  action?: "create" | "update" | "delete" | "adjust";
  source?: Platform;
  destination?: Platform;
  timestamp?: string;
  reason?: string;
}

export const processInventoryMesh = inngest.createFunction(
  {
    id: "process-inventory-mesh",
    name: "Process Inventory Sync Mesh",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 20 }],
  },
  { event: "inventory/sync" },
  async ({ event, step }) => {
    const { source, destination, payload } = event.data;
    const inventory = payload as InventorySyncPayload;

    console.log(`[InventoryMesh] ========================================`);
    console.log(`[InventoryMesh] Syncing inventory: ${source} → ${destination}`);
    console.log(`[InventoryMesh] SKU: ${inventory.sku || "N/A"}`);
    console.log(`[InventoryMesh] Inventory Item ID: ${inventory.inventoryItemId || "N/A"}`);
    console.log(`[InventoryMesh] Action: ${inventory.action || "update"}`);
    console.log(`[InventoryMesh] Quantity: ${inventory.quantity || inventory.available || "N/A"}`);
    console.log(`[InventoryMesh] Location: ${inventory.locationId || inventory.warehouseId || "N/A"}`);

    // Route to destination platform
    switch (destination) {
      case "shopify":
        return await step.run("sync-to-shopify", async () => {
          return syncToShopify(inventory, source);
        });

      case "dynamics":
        return await step.run("sync-to-dynamics", async () => {
          return syncToDynamics(inventory, source);
        });

      case "gps":
      case "warehouse":
        return await step.run("sync-to-warehouse", async () => {
          return syncToWarehouse(inventory, source, destination);
        });

      default:
        console.warn(`[InventoryMesh] Unknown destination platform: ${destination}`);
        return {
          success: false,
          message: `Unknown destination platform: ${destination}`,
        };
    }
  }
);

// ============================================================================
// SYNC TO SHOPIFY
// ============================================================================

async function syncToShopify(
  inventory: InventorySyncPayload,
  source: Platform
): Promise<{ success: boolean; message: string; data?: any }> {
  console.log(`[InventoryMesh] Syncing to Shopify from ${source}`);

  try {
    // Handle product deletion
    if (inventory.action === "delete") {
      // TODO: Implement product deletion in Shopify
      console.log(`[InventoryMesh] Product deletion not yet implemented for Shopify`);
      return {
        success: true,
        message: "Product deletion placeholder - not yet implemented",
      };
    }

    // For inventory updates, we need inventory_item_id and location_id
    if (!inventory.inventoryItemId || !inventory.locationId) {
      // Try to resolve from SKU
      if (inventory.sku) {
        // TODO: Lookup inventory_item_id from SKU
        console.log(`[InventoryMesh] Need to resolve inventory_item_id from SKU: ${inventory.sku}`);
        return {
          success: false,
          message: "inventory_item_id resolution from SKU not yet implemented",
        };
      }

      return {
        success: false,
        message: "inventory_item_id and location_id are required for Shopify sync",
      };
    }

    const quantity = inventory.quantity ?? inventory.available ?? 0;

    // Update inventory level in Shopify
    const shopDomain = config.shopify.im8.shopDomain;
    const accessToken = config.shopify.im8.accessToken;
    const apiVersion = config.shopify.im8.apiVersion;

    if (!shopDomain || !accessToken) {
      return {
        success: false,
        message: "Shopify configuration missing",
      };
    }

    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/inventory_levels/set.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          location_id: Number(inventory.locationId),
          inventory_item_id: Number(inventory.inventoryItemId),
          available: quantity,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }

    const result = await response.json();

    console.log(`[InventoryMesh] ✅ Synced to Shopify: ${quantity} units at location ${inventory.locationId}`);

    return {
      success: true,
      message: `Inventory synced to Shopify: ${quantity} units`,
      data: result,
    };
  } catch (error) {
    console.error(`[InventoryMesh] ❌ Error syncing to Shopify:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// SYNC TO DYNAMICS
// ============================================================================

async function syncToDynamics(
  inventory: InventorySyncPayload,
  source: Platform
): Promise<{ success: boolean; message: string; data?: any }> {
  console.log(`[InventoryMesh] Syncing to Dynamics from ${source}`);

  try {
    // Map location/warehouse to Dynamics dataAreaId
    const dataAreaId = inventory.dataAreaId || config.dynamics.dataAreaId;

    if (!inventory.sku) {
      return {
        success: false,
        message: "SKU is required for Dynamics sync",
      };
    }

    const quantity = inventory.quantity ?? inventory.available ?? 0;

    // Use existing Dynamics sync function
    const result = await dynamics.syncInventoryLevel({
      inventoryItemId: inventory.inventoryItemId || inventory.sku,
      locationId: inventory.locationId?.toString() || inventory.warehouseId || "",
      available: quantity,
      sku: inventory.sku,
    });

    console.log(`[InventoryMesh] ✅ Synced to Dynamics: ${result.message}`);

    return {
      success: result.success,
      message: result.message,
      data: result,
    };
  } catch (error) {
    console.error(`[InventoryMesh] ❌ Error syncing to Dynamics:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// SYNC TO WAREHOUSE (GPS, Stord, etc.)
// ============================================================================

async function syncToWarehouse(
  inventory: InventorySyncPayload,
  source: Platform,
  destination: Platform
): Promise<{ success: boolean; message: string; data?: any }> {
  console.log(`[InventoryMesh] Syncing to ${destination} warehouse from ${source}`);

  try {
    if (destination === "gps") {
      // Use existing GPS sync function
      const result = await gps.syncInventoryLevel({
        inventoryItemId: inventory.inventoryItemId || inventory.sku || "",
        locationId: inventory.locationId?.toString() || "",
        available: inventory.quantity ?? inventory.available ?? 0,
        sku: inventory.sku,
      });

      console.log(`[InventoryMesh] ✅ Synced to GPS: ${result.message}`);

      return {
        success: result.success,
        message: result.message,
        data: result,
      };
    }

    // TODO: Add other warehouse systems (Stord, Extensiv, etc.)
    return {
      success: false,
      message: `Warehouse sync for ${destination} not yet implemented`,
    };
  } catch (error) {
    console.error(`[InventoryMesh] ❌ Error syncing to warehouse:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

