// ============================================================================
// PROCESS INVENTORY FULL SYNC (from Battle Hub)
// ============================================================================
// Handles the full GPS → D365 → Shopify inventory sync pipeline.
// Triggered by Battle Hub when user clicks "Sync All".
//
// No timeout limits since Inngest can run for hours.
// Uses Inngest Realtime to stream progress back to Battle Hub.
//
// Event: inventory/sync.requested
// Channel: inventory:sync:{syncId}
// Topics: status, result

import { inngest } from "../client";
import * as gpsInventory from "@/lib/clients/gps-inventory";
import * as dynamics from "@/lib/clients/dynamics";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

// Types for sync progress
interface StepResult {
  step: "gps" | "d365" | "shopify";
  success: boolean;
  itemsProcessed: number;
  itemsSucceeded: number;
  itemsFailed: number;
  message: string;
  error?: string;
  durationMs: number;
}

interface SyncSummary {
  gps: { succeeded: number; failed: number };
  d365: { succeeded: number; failed: number };
  shopify: { succeeded: number; failed: number };
  totalDriftDetected: number;
}

export const processInventoryFullSync = inngest.createFunction(
  {
    id: "process-inventory-full-sync",
    name: "Process Inventory Full Sync (GPS → D365 → Shopify)",
    retries: RETRY_CONFIGS.DEFAULT,
    // Only one full sync at a time
    concurrency: [{ limit: 1 }],
  },
  { event: "inventory/sync.requested" },
  async ({ event, step, publish }: { event: any; step: any; publish: any }) => {
    const { syncId, steps, skus, dryRun = false, requestedBy } = event.data;
    const channel = `inventory:sync:${syncId}`;

    console.log(`[InventoryFullSync] ========================================`);
    console.log(`[InventoryFullSync] Starting full sync: ${syncId}`);
    console.log(`[InventoryFullSync] Steps: ${steps.join(" → ")}`);
    console.log(`[InventoryFullSync] Requested by: ${requestedBy}`);
    console.log(`[InventoryFullSync] Dry run: ${dryRun}`);
    if (skus?.length) {
      console.log(`[InventoryFullSync] SKUs filter: ${skus.length} items`);
    }

    const results: StepResult[] = [];
    let inventory: Map<string, { sku: string; gpsQty: number }> = new Map();

    // ========================================================================
    // STEP 1: GPS Warehouse Sync
    // ========================================================================
    if (steps.includes("gps")) {
      // Publish "running" status BEFORE the step (side effects outside step.run)
      console.log(`[InventoryFullSync] Publishing GPS running status to channel: ${channel}`);
      try {
        await publish({
          channel,
          topic: "status",
          data: {
            syncId,
            step: "gps",
            status: "running",
            message: "Pulling inventory from GPS warehouse...",
            timestamp: new Date().toISOString(),
          },
        });
        console.log(`[InventoryFullSync] GPS running status published successfully`);
      } catch (publishError) {
        console.error(`[InventoryFullSync] PUBLISH ERROR:`, publishError);
      }

      // Run the actual sync in a step (idempotent computation only)
      const gpsResult = await step.run("sync-gps", async () => {
        const startTime = Date.now();

        try {
          console.log("[InventoryFullSync] Querying GPS inventory...");

          // Query GPS inventory (both US and UK regions)
          const usItems = await gpsInventory.queryProductInventory({ region: "US" });
          const ukItems = await gpsInventory.queryProductInventory({ region: "UK" });

          // Combine and aggregate by SKU
          const allItems = [...usItems, ...ukItems];
          const skuMap = new Map<string, number>();

          for (const item of allItems) {
            if (skus && skus.length > 0 && !skus.includes(item.sku)) continue;
            const current = skuMap.get(item.sku) || 0;
            skuMap.set(item.sku, current + (item.availableQty || 0));
          }

          // Return inventory data to store after step completes
          const inventoryData = Array.from(skuMap.entries()).map(([sku, qty]) => ({
            sku,
            gpsQty: qty,
          }));

          return {
            step: "gps" as const,
            success: true,
            itemsProcessed: allItems.length,
            itemsSucceeded: skuMap.size,
            itemsFailed: 0,
            message: `Synced ${skuMap.size} SKUs from GPS`,
            error: undefined as string | undefined,
            durationMs: Date.now() - startTime,
            inventoryData,
          };
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error("[InventoryFullSync] GPS sync failed:", errMsg);

          return {
            step: "gps" as const,
            success: false,
            itemsProcessed: 0,
            itemsSucceeded: 0,
            itemsFailed: 0,
            message: "GPS sync failed",
            error: errMsg,
            durationMs: Date.now() - startTime,
            inventoryData: [] as { sku: string; gpsQty: number }[],
          };
        }
      });

      // Publish completion status AFTER the step (side effects outside step.run)
      await publish({
        channel,
        topic: "status",
        data: {
          syncId,
          step: "gps",
          status: gpsResult.success ? "completed" : "failed",
          itemsProcessed: gpsResult.itemsProcessed,
          itemsSucceeded: gpsResult.itemsSucceeded,
          itemsFailed: gpsResult.itemsFailed,
          message: gpsResult.message,
          error: gpsResult.error,
          timestamp: new Date().toISOString(),
        },
      });

      // Store inventory data for later steps
      for (const item of gpsResult.inventoryData) {
        inventory.set(item.sku, item);
      }

      results.push(gpsResult);
    }

    // ========================================================================
    // STEP 2: Dynamics 365 Sync
    // ========================================================================
    if (steps.includes("d365")) {
      // Publish "running" status BEFORE the step
      await publish({
        channel,
        topic: "status",
        data: {
          syncId,
          step: "d365",
          status: "running",
          message: "Syncing inventory to D365 sandbox...",
          timestamp: new Date().toISOString(),
        },
      });

      // Run the actual sync in a step (idempotent computation only)
      const d365Result = await step.run("sync-d365", async () => {
        const startTime = Date.now();

        try {
          console.log("[InventoryFullSync] Fetching D365 inventory for comparison...");

          // Fetch current D365 inventory
          const d365Inventory = await dynamics.getInventory({
            dataAreaId: config.dynamics.dataAreaId,
          });

          // Create lookup by item number
          const d365Map = new Map<string, number>();
          for (const item of d365Inventory.items) {
            const qty = item.AvailableOnHandQuantity || 0;
            d365Map.set(item.ItemNumber, qty);
          }

          // Compare and identify drift
          let succeeded = 0;
          let driftCount = 0;

          for (const [sku, data] of inventory) {
            const d365Qty = d365Map.get(sku) ?? null;
            const gpsQty = data.gpsQty;

            if (d365Qty !== null && d365Qty !== gpsQty) {
              driftCount++;
              console.log(`[InventoryFullSync] Drift: ${sku} GPS=${gpsQty} D365=${d365Qty}`);
            }
            succeeded++;
          }

          return {
            step: "d365" as const,
            success: true,
            itemsProcessed: inventory.size,
            itemsSucceeded: succeeded,
            itemsFailed: 0,
            message: `Compared ${succeeded} items, ${driftCount} with drift`,
            error: undefined as string | undefined,
            durationMs: Date.now() - startTime,
            driftCount,
          };
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error("[InventoryFullSync] D365 sync failed:", errMsg);

          return {
            step: "d365" as const,
            success: false,
            itemsProcessed: 0,
            itemsSucceeded: 0,
            itemsFailed: inventory.size,
            message: "D365 sync failed",
            error: errMsg,
            durationMs: Date.now() - startTime,
            driftCount: 0,
          };
        }
      });

      // Publish completion status AFTER the step
      await publish({
        channel,
        topic: "status",
        data: {
          syncId,
          step: "d365",
          status: d365Result.success ? "completed" : "failed",
          itemsProcessed: d365Result.itemsProcessed,
          itemsSucceeded: d365Result.itemsSucceeded,
          itemsFailed: d365Result.driftCount, // Report drift as "failed" for tracking
          message: d365Result.message,
          error: d365Result.error,
          timestamp: new Date().toISOString(),
        },
      });

      results.push(d365Result);
    }

    // ========================================================================
    // STEP 3: Shopify Sync
    // ========================================================================
    if (steps.includes("shopify")) {
      // Publish "running" status BEFORE the step
      await publish({
        channel,
        topic: "status",
        data: {
          syncId,
          step: "shopify",
          status: "running",
          message: "Syncing inventory to Shopify...",
          timestamp: new Date().toISOString(),
        },
      });

      // Run the actual sync in a step (idempotent computation only)
      const shopifyResult = await step.run("sync-shopify", async () => {
        const startTime = Date.now();

        try {
          console.log("[InventoryFullSync] Shopify sync is de-emphasized");
          console.log("[InventoryFullSync] Shopify doesn't track inventory (continues selling when OOS)");

          // Shopify sync is informational only - we don't actively push
          // because Shopify is not the source of truth for inventory
          return {
            step: "shopify" as const,
            success: true,
            itemsProcessed: inventory.size,
            itemsSucceeded: inventory.size,
            itemsFailed: 0,
            message: `Shopify sync skipped (de-emphasized)`,
            error: undefined as string | undefined,
            durationMs: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error("[InventoryFullSync] Shopify sync failed:", errMsg);

          return {
            step: "shopify" as const,
            success: false,
            itemsProcessed: 0,
            itemsSucceeded: 0,
            itemsFailed: inventory.size,
            message: "Shopify sync failed",
            error: errMsg,
            durationMs: Date.now() - startTime,
          };
        }
      });

      // Publish completion status AFTER the step
      await publish({
        channel,
        topic: "status",
        data: {
          syncId,
          step: "shopify",
          status: shopifyResult.success ? "completed" : "failed",
          itemsProcessed: shopifyResult.itemsProcessed,
          itemsSucceeded: shopifyResult.itemsSucceeded,
          itemsFailed: shopifyResult.itemsFailed,
          message: shopifyResult.message,
          error: shopifyResult.error,
          timestamp: new Date().toISOString(),
        },
      });

      results.push(shopifyResult);
    }

    // ========================================================================
    // FINAL: Publish Result
    // ========================================================================
    const gpsStep = results.find((r) => r.step === "gps");
    const d365Step = results.find((r) => r.step === "d365") as (StepResult & { driftCount?: number }) | undefined;
    const shopifyStep = results.find((r) => r.step === "shopify");

    const overallSuccess = results.every((r) => r.success);
    const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const summary: SyncSummary = {
      gps: {
        succeeded: gpsStep?.itemsSucceeded || 0,
        failed: gpsStep?.itemsFailed || 0,
      },
      d365: {
        succeeded: d365Step?.itemsSucceeded || 0,
        failed: d365Step?.itemsFailed || 0,
      },
      shopify: {
        succeeded: shopifyStep?.itemsSucceeded || 0,
        failed: shopifyStep?.itemsFailed || 0,
      },
      totalDriftDetected: d365Step?.driftCount || 0,
    };

    // Publish final result (no step.run needed - publish is a side effect)
    await publish({
      channel,
      topic: "result",
      data: {
        syncId,
        success: overallSuccess,
        summary,
        totalDurationMs,
        timestamp: new Date().toISOString(),
      },
    });

    console.log(`[InventoryFullSync] ========================================`);
    console.log(`[InventoryFullSync] Sync complete: ${syncId}`);
    console.log(`[InventoryFullSync] Success: ${overallSuccess}`);
    console.log(`[InventoryFullSync] Duration: ${totalDurationMs}ms`);
    console.log(`[InventoryFullSync] Summary: GPS=${summary.gps.succeeded}, D365=${summary.d365.succeeded}, Shopify=${summary.shopify.succeeded}`);
    console.log(`[InventoryFullSync] Drift detected: ${summary.totalDriftDetected}`);
    console.log(`[InventoryFullSync] ========================================`);

    return {
      syncId,
      success: overallSuccess,
      summary,
      totalDurationMs,
      results,
    };
  }
);
