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
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

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

// Battle Hub webhook URL for inventory sync results
const BATTLE_HUB_URL = process.env.BATTLE_HUB_URL || "";

/**
 * Notify Battle Hub of inventory sync completion
 * Updates Supabase with per-system quantities and sync timestamps
 */
async function notifyBattleHub(
  sku: string,
  system: "gps" | "shopify" | "d365",
  quantity: number,
  syncStatus: "synced" | "failed",
  error?: string
): Promise<void> {
  if (!BATTLE_HUB_URL) {
    console.log("[InventoryMesh] BATTLE_HUB_URL not configured, skipping callback");
    return;
  }

  try {
    const response = await fetch(`${BATTLE_HUB_URL}/api/webhooks/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku,
        system,
        quantity,
        syncStatus,
        timestamp: new Date().toISOString(),
        ...(error && { error }),
      }),
    });

    if (!response.ok) {
      console.error(`[InventoryMesh] Hub callback failed: ${response.status}`);
    } else {
      console.log(`[InventoryMesh] ✅ Notified Hub: ${sku} ${system}=${quantity}`);
    }
  } catch (err) {
    console.error("[InventoryMesh] Hub callback error:", err);
  }
}

export const processInventoryMesh = inngest.createFunction(
  {
    id: "process-inventory-mesh",
    name: "Process Inventory Sync Mesh",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: "inventory/sync" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { source, destination, payload } = event.data;

    logFlowEvent({
      flow: "inventory_mesh",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { source, destination, sku: (payload as InventorySyncPayload)?.sku },
    });

    if (!config.features.enableInventorySync) {
      console.log(
        `[InventoryMesh] Skipped ${source} → ${destination} — ENABLE_INVENTORY_SYNC is false`
      );
      logFlowEvent({
        flow: "inventory_mesh",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { source, destination, skipped: true },
      });
      return {
        status: "skipped",
        reason: "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)",
        source,
        destination,
      };
    }
    const inventory = payload as InventorySyncPayload;

    console.log(`[InventoryMesh] ========================================`);
    console.log(`[InventoryMesh] Syncing inventory: ${source} → ${destination}`);
    console.log(`[InventoryMesh] SKU: ${inventory.sku || "N/A"}`);
    console.log(`[InventoryMesh] Inventory Item ID: ${inventory.inventoryItemId || "N/A"}`);
    console.log(`[InventoryMesh] Action: ${inventory.action || "update"}`);
    console.log(`[InventoryMesh] Quantity: ${inventory.quantity || inventory.available || "N/A"}`);
    console.log(
      `[InventoryMesh] Location: ${inventory.locationId || inventory.warehouseId || "N/A"}`
    );

    let result: { success: boolean; message: string; data?: any };

    // Route to destination platform
    switch (destination) {
      case "shopify":
        result = await step.run("sync-to-shopify", async () => {
          return syncToShopify(inventory, source);
        });
        break;

      case "dynamics":
        result = await step.run("sync-to-dynamics", async () => {
          return syncToDynamics(inventory, source);
        });

        // After syncing to Dynamics, ALWAYS sync from Dynamics to Shopify
        // Flow: Location → Dynamics → Shopify (one-way, mandatory)
        if (result.success && inventory.sku) {
          const sku = inventory.sku; // Type narrowing
          const shopifyResult = await step.run("sync-dynamics-to-shopify", async () => {
            console.log(`[InventoryMesh] 🔄 Auto-triggering D365 → Shopify sync for SKU: ${sku}`);
            const { syncD365ToShopify } = await import("@/lib/services/inventory-sync");
            const dataAreaId = result.data?.dataAreaId || config.dynamics.dataAreaId;
            const syncResult = await syncD365ToShopify(sku, dataAreaId);
            console.log(`[InventoryMesh] ✅ D365 → Shopify sync result: ${syncResult.message}`);
            return syncResult;
          });

          // Update result to include Shopify sync status
          if (shopifyResult) {
            result = {
              ...result,
              message: `${result.message} → Shopify: ${shopifyResult.message}`,
              data: {
                ...result.data,
                shopifySync: shopifyResult,
              },
            };
          }
        }
        break;

      case "gps":
      case "warehouse":
        result = await step.run("sync-to-warehouse", async () => {
          return syncToWarehouse(inventory, source, destination);
        });
        break;

      default:
        console.warn(`[InventoryMesh] Unknown destination platform: ${destination}`);
        result = {
          success: false,
          message: `Unknown destination platform: ${destination}`,
        };
    }

    // Callback to Battle Hub with sync result
    if (inventory.sku) {
      await step.run("notify-battle-hub", async () => {
        const systemMap: Record<string, "gps" | "shopify" | "d365"> = {
          shopify: "shopify",
          dynamics: "d365",
          gps: "gps",
          warehouse: "gps",
        };
        const system = systemMap[destination] || "gps";
        const quantity = inventory.quantity ?? inventory.available ?? 0;

        await notifyBattleHub(
          inventory.sku!,
          system,
          quantity,
          result.success ? "synced" : "failed",
          result.success ? undefined : result.message
        );
      });
    }

    logFlowEvent({
      flow: "inventory_mesh",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        source,
        destination,
        sku: inventory.sku,
        locationId: inventory.locationId,
        warehouseId: inventory.warehouseId,
        success: result.success,
      },
    });

    return result;
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

    console.log(
      `[InventoryMesh] ✅ Synced to Shopify: ${quantity} units at location ${inventory.locationId}`
    );

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
    // Priority: 1. Explicit dataAreaId in payload, 2. Location-based mapping, 3. Default
    let dataAreaId = inventory.dataAreaId;

    if (!dataAreaId && inventory.locationId) {
      // Use location routing service to get DataAreaId from Shopify location ID (one-way: locations → Dynamics)
      const { getDataAreaIdForLocation } = await import("@/lib/services/location-routing");
      const routedDataAreaId = await getDataAreaIdForLocation(inventory.locationId, "im8");
      if (routedDataAreaId) {
        dataAreaId = routedDataAreaId;
        console.log(
          `[InventoryMesh] Mapped location ${inventory.locationId} to dataAreaId ${dataAreaId} via location routing`
        );
      } else {
        // Fallback to existing validation if location routing didn't work
        const { getDataAreaIdFromLocation } = await import("@/lib/utils/validation");
        dataAreaId = getDataAreaIdFromLocation(inventory.locationId) ?? undefined;
        console.log(
          `[InventoryMesh] Mapped location ${inventory.locationId} to dataAreaId ${dataAreaId} via validation utils`
        );
      }
    }

    if (!dataAreaId && inventory.warehouseName) {
      // Try to get from warehouse name
      const { getDataAreaId } = await import("@/lib/helpers/warehouse");
      try {
        dataAreaId = getDataAreaId(inventory.warehouseName);
        console.log(
          `[InventoryMesh] Mapped warehouse ${inventory.warehouseName} to dataAreaId ${dataAreaId}`
        );
      } catch {
        // Fallback to default
      }
    }

    // Final fallback to default
    if (!dataAreaId) {
      dataAreaId = config.dynamics.dataAreaId;
      console.log(`[InventoryMesh] Using default dataAreaId: ${dataAreaId}`);
    }

    if (!inventory.sku) {
      return {
        success: false,
        message: "SKU is required for Dynamics sync",
      };
    }

    const quantity = inventory.quantity ?? inventory.available ?? 0;

    // Use existing Dynamics sync function with location-specific dataAreaId
    const result = await dynamics.syncInventoryLevel({
      inventoryItemId: inventory.inventoryItemId || inventory.sku,
      locationId: inventory.locationId?.toString() || inventory.warehouseId || "",
      available: quantity,
      sku: inventory.sku,
      dataAreaId, // Pass the resolved dataAreaId
    });

    console.log(`[InventoryMesh] ✅ Synced to Dynamics (${dataAreaId}): ${result.message}`);

    return {
      success: result.success,
      message: result.message,
      data: { ...result, dataAreaId },
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
