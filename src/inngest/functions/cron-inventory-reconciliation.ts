// ============================================================================
// INVENTORY RECONCILIATION (Scheduled)
// ============================================================================
// 3-Way Inventory Sync: GPS <-> Dynamics 365 <-> Shopify
//
// Flow:
//   1. Query GPS inventory (warehouse physical stock)
//   2. Query D365 inventory (ERP on-hand)
//   3. Query Shopify inventory (storefront available)
//   4. Calculate discrepancies
//   5. Sync discrepancies: GPS -> D365 -> Shopify
//
// Schedule:
//   - Runs every 2 hours by default (configurable via GPS_INVENTORY_SYNC_INTERVAL_MINUTES)
//   - Can be triggered manually via API

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as inventorySync from "@/lib/services/inventory-sync";
import type { InventoryDiff } from "@/lib/services/inventory-sync";
import * as slack from "@/lib/clients/slack";
import { THROTTLE_CONFIGS, RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

// ============================================================================
// CONFIGURATION
// ============================================================================

// SKUs to monitor for inventory sync
// In production, this would come from a database or configuration
const MONITORED_SKUS = [
  "IM8-FG-000010",
  "IM8-FG-000011",
  "IM8-FG-000012",
  "IM8-FG-000030",
  "IM8-FG-000031",
  "IM8-FG-000035",
  "IM8-FG-000040",
  "IM8-FG-000048",
  "IM8-FG-000053",
  "IM8-FG-000057",
  "IM8-FG-000064",
  "IM8-FG-000093",
  "IM8-FG-000135",
];

// Warehouses to sync
const WAREHOUSES = ["GPS Warehouse", "GPS UK Warehouse"] as const;

// ============================================================================
// SCHEDULED FUNCTION
// ============================================================================

export const cronInventoryReconciliation = inngest.createFunction(
  {
    id: "cron-inventory-reconciliation",
    name: "3-Way Inventory Reconciliation",
    retries: RETRY_CONFIGS.CRON,
    concurrency: { limit: 1 },
    throttle: THROTTLE_CONFIGS.CRON,
    triggers: [{ cron: `*/${config.gps.inventorySyncIntervalMinutes || 120} * * * *` }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { trigger: "cron", warehouses: WAREHOUSES },
    });

    console.log("[InventoryReconciliation] Starting scheduled reconciliation");

    // Check if inventory sync is enabled
    if (!config.features.enableGpsSync) {
      console.log("[InventoryReconciliation] GPS sync disabled, skipping");
      logFlowEvent({
        flow: "inventory_reconciliation",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { trigger: "cron", skipped: true, reason: "gps_sync_disabled" },
      });
      return {
        status: "skipped",
        reason: "GPS sync disabled (set ENABLE_GPS_SYNC=true to enable)",
      };
    }

    // Check if GPS credentials are configured
    if (!config.gps.apiKey || !config.gpsUk.apiKey) {
      console.log("[InventoryReconciliation] GPS credentials not configured, skipping");
      logFlowEvent({
        flow: "inventory_reconciliation",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { trigger: "cron", skipped: true, reason: "gps_credentials_missing" },
      });
      return {
        status: "skipped",
        reason: "GPS API credentials not configured (check GPS_API_KEY/GPS_UK_API_KEY)",
      };
    }

    // Note: Inngest serializes Date to string, so we use a looser type here
    const results: {
      warehouse: string;
      reconciliation: Omit<inventorySync.ReconciliationResult, "timestamp"> & {
        timestamp: Date | string;
      };
    }[] = [];

    // STEP 1: Run reconciliation for each warehouse
    for (const warehouse of WAREHOUSES) {
      const reconciliation = await step.run(
        `reconcile-${warehouse.toLowerCase().replace(/\s+/g, "-")}`,
        async () => {
          console.log(`[InventoryReconciliation] Processing ${warehouse}`);

          try {
            const result = await inventorySync.runReconciliation(
              MONITORED_SKUS,
              warehouse,
              config.features.enableInventorySync // when false: discrepancy report only, no writes
            );
            return result;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[InventoryReconciliation] ${warehouse} error: ${errorMessage}`);
            return {
              timestamp: new Date(),
              skusChecked: MONITORED_SKUS.length,
              discrepanciesFound: 0,
              syncActions: [],
              errors: [errorMessage],
            } as inventorySync.ReconciliationResult;
          }
        }
      );

      results.push({ warehouse, reconciliation });

      // Small delay between warehouses
      await step.sleep("warehouse-delay", "1s");
    }

    // STEP 2: Summarize results
    const summary = await step.run("summarize-results", async () => {
      const totalSkus = results.reduce((sum, r) => sum + r.reconciliation.skusChecked, 0);
      const totalDiscrepancies = results.reduce(
        (sum, r) => sum + r.reconciliation.discrepanciesFound,
        0
      );
      const totalSyncActions = results.reduce(
        (sum, r) => sum + r.reconciliation.syncActions.length,
        0
      );
      const totalErrors = results.reduce((sum, r) => sum + r.reconciliation.errors.length, 0);

      const successfulSyncs = results.flatMap((r) =>
        r.reconciliation.syncActions.filter((a) => a.success)
      );
      const failedSyncs = results.flatMap((r) =>
        r.reconciliation.syncActions.filter((a) => !a.success)
      );

      return {
        timestamp: new Date().toISOString(),
        warehouses: WAREHOUSES.length,
        totalSkusChecked: totalSkus,
        totalDiscrepancies,
        totalSyncActions,
        successfulSyncs: successfulSyncs.length,
        failedSyncs: failedSyncs.length,
        totalErrors,
      };
    });

    // STEP 3: Send notifications if there were issues
    if (summary.totalDiscrepancies > 0 || summary.totalErrors > 0) {
      await step.run("send-notifications", async () => {
        const emoji = summary.totalErrors > 0 ? "⚠️" : "📊";
        const message = [
          `${emoji} Inventory Reconciliation Complete`,
          ``,
          `📦 SKUs Checked: ${summary.totalSkusChecked}`,
          `🔍 Discrepancies Found: ${summary.totalDiscrepancies}`,
          `✅ Successful Syncs: ${summary.successfulSyncs}`,
          `❌ Failed Syncs: ${summary.failedSyncs}`,
          summary.totalErrors > 0 ? `⚠️ Errors: ${summary.totalErrors}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        await slack.sendInfoMessage("gps", message);
      });
    }

    console.log("[InventoryReconciliation] Completed:", summary);

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        trigger: "cron",
        totalSkusChecked: summary.totalSkusChecked,
        totalDiscrepancies: summary.totalDiscrepancies,
        totalSyncActions: summary.totalSyncActions,
      },
    });

    return {
      status: "completed",
      summary,
      details: results.map((r) => ({
        warehouse: r.warehouse,
        skusChecked: r.reconciliation.skusChecked,
        discrepanciesFound: r.reconciliation.discrepanciesFound,
        syncActions: r.reconciliation.syncActions.length,
        errors: r.reconciliation.errors,
      })),
    };
  }
);

// ============================================================================
// MANUAL TRIGGER EVENT
// ============================================================================

export const triggerInventoryReconciliation = inngest.createFunction(
  {
    id: "trigger-inventory-reconciliation",
    name: "Trigger Inventory Reconciliation",
    triggers: [{ event: "inventory/reconciliation.requested" }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { skus, warehouse, autoSync = false } = event.data;
    const effectiveAutoSync = Boolean(autoSync && config.features.enableInventorySync);

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        trigger: "manual",
        skuCount: skus?.length,
        warehouse: warehouse || "all",
        autoSync: effectiveAutoSync,
      },
    });

    console.log(
      `[InventoryReconciliation] Manual trigger: ${skus?.length || "all"} SKUs, warehouse: ${warehouse || "all"}, autoSync: ${effectiveAutoSync}${!config.features.enableInventorySync && autoSync ? " (forced off: ENABLE_INVENTORY_SYNC=false)" : ""}`
    );

    const skusToCheck = skus || MONITORED_SKUS;

    // Run reconciliation
    const result = await step.run("run-reconciliation", async () => {
      return inventorySync.runReconciliation(skusToCheck, warehouse, effectiveAutoSync);
    });

    // Calculate discrepancies for reporting
    const discrepancies = await step.run("calculate-discrepancies", async () => {
      return inventorySync.calculateDiscrepancies(skusToCheck, warehouse);
    });

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: {
        trigger: "manual",
        warehouse: warehouse || "all",
        discrepanciesFound: discrepancies.filter((d: InventoryDiff) => d.needsSync).length,
      },
    });

    return {
      status: "completed",
      reconciliation: result,
      discrepancies: discrepancies.filter((d: InventoryDiff) => d.needsSync),
    };
  }
);

// ============================================================================
// INDIVIDUAL SKU SYNC EVENT
// ============================================================================

export const syncSkuInventory = inngest.createFunction(
  {
    id: "sync-sku-inventory",
    name: "Sync SKU Inventory",
    retries: RETRY_CONFIGS.STANDARD,
    concurrency: { limit: 2 },
    triggers: [{ event: "inventory/sku.sync.requested" }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { sku, source, destination, warehouse } = event.data;

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { sku, source, destination, warehouse },
    });

    if (!config.features.enableInventorySync) {
      console.log(`[InventorySync] Skipped ${sku} — ENABLE_INVENTORY_SYNC is false`);
      logFlowEvent({
        flow: "inventory_reconciliation",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { sku, source, destination, skipped: true },
      });
      return {
        status: "skipped",
        reason: "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)",
        sku,
        source,
        destination,
      };
    }

    console.log(
      `[InventorySync] Syncing ${sku}: ${source} -> ${destination} (${warehouse || "all"})`
    );

    let result: inventorySync.SyncResult;

    if (source === "gps" && destination === "d365") {
      result = await step.run("sync-gps-to-d365", async () => {
        return inventorySync.syncGpsToD365(sku, warehouse || "GPS Warehouse");
      });
    } else if (source === "d365" && destination === "shopify") {
      result = await step.run("sync-d365-to-shopify", async () => {
        return inventorySync.syncD365ToShopify(sku);
      });
    } else {
      result = {
        success: false,
        message: `Unsupported sync direction: ${source} -> ${destination}`,
        sku,
        source,
        destination,
        error: "UNSUPPORTED_DIRECTION",
      };
    }

    // Chain syncs: if GPS -> D365 succeeded, also sync D365 -> Shopify
    if (result.success && source === "gps" && destination === "d365") {
      const shopifyResult = await step.run("chain-d365-to-shopify", async () => {
        return inventorySync.syncD365ToShopify(sku);
      });

      logFlowEvent({
        flow: "inventory_reconciliation",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { sku, source, destination, warehouse, chainedShopify: true },
      });

      return {
        status: "completed",
        gpsToD365: result,
        d365ToShopify: shopifyResult,
      };
    }

    logFlowEvent({
      flow: "inventory_reconciliation",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { sku, source, destination, warehouse, success: result.success },
    });

    return {
      status: result.success ? "completed" : "failed",
      result,
    };
  }
);
