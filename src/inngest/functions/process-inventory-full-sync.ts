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
import { inventorySyncChannel } from "../channels";
import * as gpsInventory from "@/lib/clients/gps-inventory";
import * as dynamics from "@/lib/clients/dynamics";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { syncD365ToShopify } from "@/lib/services/inventory-sync";
import { getWarehouseConfig } from "@/lib/helpers/warehouse";

type GpsRegion = "US" | "UK";
type RegionalInventory = {
  sku: string;
  gpsQty: number;
  region: GpsRegion;
  dataAreaId: string;
};

const GPS_REGIONS: Array<{ region: GpsRegion; dataAreaId: string }> = [
  { region: "US", dataAreaId: getWarehouseConfig("GPS Warehouse").dataAreaId },
  { region: "UK", dataAreaId: getWarehouseConfig("GPS UK Warehouse").dataAreaId },
];

function regionalInventoryKey(dataAreaId: string, sku: string): string {
  return `${dataAreaId.toUpperCase()}:${sku}`;
}

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
    triggers: [{ event: "inventory/sync.requested" }],
    // Only one full sync at a time
    concurrency: [{ limit: 1 }],
  },
  async ({ event, step, publish }: { event: any; step: any; publish: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { syncId, steps, skus, dryRun = false, requestedBy } = event.data;
    const ch = inventorySyncChannel({ syncId });
    const publishToRealtime = async (channel: unknown, payload: Record<string, unknown>) => {
      if (typeof publish !== "function") return;
      await publish(channel, payload);
    };

    logFlowEvent({
      flow: "inventory_full_sync",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { syncId, steps, skuCount: skus?.length, dryRun, requestedBy },
    });

    if (!config.features.enableInventorySync) {
      const reason = "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)";
      console.log(`[InventoryFullSync] Skipped: ${reason}`);
      try {
        await publishToRealtime(ch.status, {
          syncId,
          step: "result",
          status: "failed",
          message: reason,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("[InventoryFullSync] publish skipped status failed:", e);
      }
      logFlowEvent({
        flow: "inventory_full_sync",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { syncId, skipped: true, reason },
      });
      return { syncId, success: false, skipped: true, reason };
    }

    console.log(`[InventoryFullSync] ========================================`);
    console.log(`[InventoryFullSync] Starting full sync: ${syncId}`);
    console.log(`[InventoryFullSync] Steps: ${steps.join(" → ")}`);
    console.log(`[InventoryFullSync] Requested by: ${requestedBy}`);
    console.log(`[InventoryFullSync] Dry run: ${dryRun}`);
    if (skus?.length) {
      console.log(`[InventoryFullSync] SKUs filter: ${skus.length} items`);
    }

    const results: StepResult[] = [];
    const inventory: Map<string, RegionalInventory> = new Map();

    // ========================================================================
    // STEP 1: GPS Warehouse Sync
    // ========================================================================
    if (steps.includes("gps")) {
      // Publish "running" status BEFORE the step (side effects outside step.run)
      console.log(`[InventoryFullSync] Publishing GPS running status`);
      try {
        await publishToRealtime(ch.status, {
          syncId,
          step: "gps",
          status: "running",
          message: "Pulling inventory from GPS warehouse...",
          timestamp: new Date().toISOString(),
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

          const regionalItems = await Promise.all(
            GPS_REGIONS.map(async ({ region, dataAreaId }) => ({
              region,
              dataAreaId,
              items: await gpsInventory.queryProductInventory({ region }),
            }))
          );

          // Aggregate only within a region. The same SKU in US and UK represents
          // two independent D365 companies and Shopify locations.
          const regionalMap = new Map<string, RegionalInventory>();
          for (const regional of regionalItems) {
            for (const item of regional.items) {
              if (skus && skus.length > 0 && !skus.includes(item.sku)) continue;
              const key = regionalInventoryKey(regional.dataAreaId, item.sku);
              const current = regionalMap.get(key);
              regionalMap.set(key, {
                sku: item.sku,
                gpsQty: (current?.gpsQty || 0) + (item.availableQty || 0),
                region: regional.region,
                dataAreaId: regional.dataAreaId,
              });
            }
          }

          const inventoryData = Array.from(regionalMap.values());
          const itemsProcessed = regionalItems.reduce((sum, item) => sum + item.items.length, 0);

          return {
            step: "gps" as const,
            success: true,
            itemsProcessed,
            itemsSucceeded: regionalMap.size,
            itemsFailed: 0,
            message: `Synced ${regionalMap.size} regional SKU record(s) from GPS`,
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
            inventoryData: [] as RegionalInventory[],
          };
        }
      });

      // Publish completion status AFTER the step (side effects outside step.run)
      await publishToRealtime(ch.status, {
        syncId,
        step: "gps",
        status: gpsResult.success ? "completed" : "failed",
        itemsProcessed: gpsResult.itemsProcessed,
        itemsSucceeded: gpsResult.itemsSucceeded,
        itemsFailed: gpsResult.itemsFailed,
        message: gpsResult.message,
        error: gpsResult.error,
        timestamp: new Date().toISOString(),
      });

      // Store inventory data for later steps
      for (const item of gpsResult.inventoryData) {
        inventory.set(regionalInventoryKey(item.dataAreaId, item.sku), item);
      }

      results.push(gpsResult);
    }

    // ========================================================================
    // STEP 2: Dynamics 365 Sync
    // ========================================================================
    if (steps.includes("d365")) {
      // Publish "running" status BEFORE the step
      await publishToRealtime(ch.status, {
        syncId,
        step: "d365",
        status: "running",
        message: "Syncing inventory to D365 sandbox...",
        timestamp: new Date().toISOString(),
      });

      // Run the actual sync in a step (idempotent computation only)
      const d365Result = await step.run("sync-d365", async () => {
        const startTime = Date.now();

        try {
          console.log("[InventoryFullSync] Fetching D365 inventory for comparison...");

          const dataAreaIds = Array.from(
            new Set(Array.from(inventory.values()).map((item) => item.dataAreaId))
          );
          const regionalD365Inventory = await Promise.all(
            dataAreaIds.map(async (dataAreaId) => ({
              dataAreaId,
              inventory: await dynamics.getInventory({ dataAreaId }),
            }))
          );

          // Keep the same SKU independent in each D365 company.
          const d365Map = new Map<string, number>();
          for (const regional of regionalD365Inventory) {
            for (const item of regional.inventory.items) {
              const qty = item.AvailableOnHandQuantity || 0;
              d365Map.set(regionalInventoryKey(regional.dataAreaId, item.ItemNumber), qty);
            }
          }

          // Compare and identify drift
          let succeeded = 0;
          let driftCount = 0;

          for (const data of inventory.values()) {
            const d365Qty = d365Map.get(regionalInventoryKey(data.dataAreaId, data.sku)) ?? null;
            const gpsQty = data.gpsQty;

            if (d365Qty !== null && d365Qty !== gpsQty) {
              driftCount++;
              console.log(
                `[InventoryFullSync] Drift: ${data.dataAreaId}/${data.sku} GPS=${gpsQty} D365=${d365Qty}`
              );
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
      await publishToRealtime(ch.status, {
        syncId,
        step: "d365",
        status: d365Result.success ? "completed" : "failed",
        itemsProcessed: d365Result.itemsProcessed,
        itemsSucceeded: d365Result.itemsSucceeded,
        itemsFailed: d365Result.driftCount, // Report drift as "failed" for tracking
        message: d365Result.message,
        error: d365Result.error,
        timestamp: new Date().toISOString(),
      });

      results.push(d365Result);
    }

    // ========================================================================
    // STEP 3: Shopify Sync
    // ========================================================================
    if (steps.includes("shopify")) {
      // Publish "running" status BEFORE the step
      await publishToRealtime(ch.status, {
        syncId,
        step: "shopify",
        status: "running",
        message: "Syncing inventory to Shopify...",
        timestamp: new Date().toISOString(),
      });

      // Run the actual sync in a step (idempotent computation only)
      const shopifyResult = await step.run("sync-shopify", async () => {
        const startTime = Date.now();
        let candidateCount = 0;

        try {
          const requestedSkus = Array.isArray(skus) ? skus.map((sku) => String(sku)) : [];
          const candidates: Array<{ sku: string; dataAreaId: string }> =
            inventory.size > 0
              ? Array.from(inventory.values()).map(({ sku, dataAreaId }) => ({ sku, dataAreaId }))
              : requestedSkus.flatMap((sku) =>
                  GPS_REGIONS.map(({ dataAreaId }) => ({ sku, dataAreaId }))
                );
          const uniqueCandidates = Array.from(
            new Map(
              candidates.map((candidate) => [
                regionalInventoryKey(candidate.dataAreaId, candidate.sku),
                candidate,
              ])
            ).values()
          );
          candidateCount = uniqueCandidates.length;
          if (uniqueCandidates.length === 0) {
            throw new Error("Shopify sync requires SKUs or a completed GPS inventory step");
          }

          if (dryRun) {
            return {
              step: "shopify" as const,
              success: true,
              itemsProcessed: uniqueCandidates.length,
              itemsSucceeded: uniqueCandidates.length,
              itemsFailed: 0,
              message: `DRY RUN - Would sync ${uniqueCandidates.length} regional SKU record(s) from D365 to Shopify`,
              error: undefined as string | undefined,
              durationMs: Date.now() - startTime,
            };
          }

          let succeeded = 0;
          const failures: Array<{ sku: string; dataAreaId: string; error: string }> = [];
          for (const { sku, dataAreaId } of uniqueCandidates) {
            const result = await syncD365ToShopify(
              sku,
              dataAreaId,
              `${syncId}:${dataAreaId}:${sku}`
            );
            if (result.success) succeeded += 1;
            else failures.push({ sku, dataAreaId, error: result.error || result.message });
          }

          return {
            step: "shopify" as const,
            success: failures.length === 0,
            itemsProcessed: uniqueCandidates.length,
            itemsSucceeded: succeeded,
            itemsFailed: failures.length,
            message: `Synced ${succeeded} regional SKU record(s) from D365 to Shopify`,
            error: failures.length > 0 ? JSON.stringify(failures) : undefined,
            durationMs: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error("[InventoryFullSync] Shopify sync failed:", errMsg);

          return {
            step: "shopify" as const,
            success: false,
            itemsProcessed: candidateCount,
            itemsSucceeded: 0,
            itemsFailed: candidateCount,
            message: "Shopify sync failed",
            error: errMsg,
            durationMs: Date.now() - startTime,
          };
        }
      });

      // Publish completion status AFTER the step
      await publishToRealtime(ch.status, {
        syncId,
        step: "shopify",
        status: shopifyResult.success ? "completed" : "failed",
        itemsProcessed: shopifyResult.itemsProcessed,
        itemsSucceeded: shopifyResult.itemsSucceeded,
        itemsFailed: shopifyResult.itemsFailed,
        message: shopifyResult.message,
        error: shopifyResult.error,
        timestamp: new Date().toISOString(),
      });

      results.push(shopifyResult);
    }

    // ========================================================================
    // FINAL: Publish Result
    // ========================================================================
    const gpsStep = results.find((r) => r.step === "gps");
    const d365Step = results.find((r) => r.step === "d365") as
      | (StepResult & { driftCount?: number })
      | undefined;
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
    await publishToRealtime(ch.status, {
      syncId,
      step: "result",
      status: overallSuccess ? "completed" : "failed",
      message: `Sync ${overallSuccess ? "completed" : "failed"} in ${totalDurationMs}ms`,
      timestamp: new Date().toISOString(),
    });

    console.log(`[InventoryFullSync] ========================================`);
    console.log(`[InventoryFullSync] Sync complete: ${syncId}`);
    console.log(`[InventoryFullSync] Success: ${overallSuccess}`);
    console.log(`[InventoryFullSync] Duration: ${totalDurationMs}ms`);
    console.log(
      `[InventoryFullSync] Summary: GPS=${summary.gps.succeeded}, D365=${summary.d365.succeeded}, Shopify=${summary.shopify.succeeded}`
    );
    console.log(`[InventoryFullSync] Drift detected: ${summary.totalDriftDetected}`);
    console.log(`[InventoryFullSync] ========================================`);

    logFlowEvent({
      flow: "inventory_full_sync",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { syncId, success: overallSuccess, totalDurationMs, dryRun },
    });

    return {
      syncId,
      success: overallSuccess,
      summary,
      totalDurationMs,
      results,
    };
  }
);
