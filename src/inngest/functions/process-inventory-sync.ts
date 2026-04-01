// ============================================================================
// SHOPIFY INVENTORY → D365 & GPS SYNC
// ============================================================================
// Processes Shopify inventory_levels/update webhooks
// 1. Receives inventory level change from Shopify
// 2. Syncs to D365 (placeholder)
// 3. Syncs to GPS (placeholder)
//
// Uses debounce to avoid processing rapid-fire Shopify inventory updates
// for the same item+location (Shopify often sends multiple updates in quick succession)

import { inngest } from "../client";
import type { ShopifyInventoryLevelPayload } from "../events";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import * as slack from "@/lib/clients/slack";
import { SlackChannelEnum } from "@/lib/types/slack";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { config } from "@/lib/config";

export const processInventorySync = inngest.createFunction(
  {
    id: "process-inventory-sync",
    name: "Process Shopify Inventory Sync",
    retries: RETRY_CONFIGS.DEFAULT,
    // Debounce rapid inventory updates for the same item+location
    // Shopify often fires multiple inventory_levels/update webhooks in quick succession
    debounce: {
      period: "10s",
      key: "event.data.inventoryItemId + '-' + event.data.locationId",
    },
    concurrency: [{ limit: 5 }],
    triggers: [{ event: "shopify/inventory.updated" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { inventoryItemId, locationId, shopifyStore, inventoryJson } = event.data;
    const inventory = inventoryJson as ShopifyInventoryLevelPayload;

    if (!config.features.enableInventorySync) {
      console.log(`[InventorySync] Skipped — ENABLE_INVENTORY_SYNC is false`);
      return {
        status: "skipped",
        reason: "Inventory sync disabled (ENABLE_INVENTORY_SYNC=false)",
        inventoryItemId,
        locationId,
      };
    }

    console.log(`[InventorySync] ========================================`);
    console.log(`[InventorySync] Processing inventory update from ${shopifyStore}`);
    console.log(`[InventorySync] Inventory Item ID: ${inventoryItemId}`);
    console.log(`[InventorySync] Location ID: ${locationId}`);
    console.log(`[InventorySync] Available: ${inventory.available}`);
    console.log(`[InventorySync] Updated At: ${inventory.updated_at}`);

    // Step 1: Sync inventory to D365
    const d365Result = await step.run("sync-inventory-to-d365", async () => {
      console.log(`[InventorySync] Syncing inventory to D365...`);
      return dynamics.syncInventoryLevel({
        inventoryItemId,
        locationId,
        available: inventory.available,
      });
    });

    console.log(`[InventorySync] D365 result: ${d365Result.message}`);

    // Step 2: Sync inventory to GPS
    const gpsResult = await step.run("sync-inventory-to-gps", async () => {
      console.log(`[InventorySync] Syncing inventory to GPS...`);
      return gps.syncInventoryLevel({
        inventoryItemId,
        locationId,
        available: inventory.available,
      });
    });

    console.log(`[InventorySync] GPS result: ${gpsResult.message}`);

    // Step 3: Log result (only Slack-notify on errors or significant changes)
    await step.run("log-inventory-sync", async () => {
      if (!d365Result.success || !gpsResult.success) {
        await slack.sendWarningMessage(
          SlackChannelEnum.SHOPIFY,
          `⚠️ Inventory sync issue for item ${inventoryItemId} at location ${locationId}\nAvailable: ${inventory.available}\nD365: ${d365Result.message}\nGPS: ${gpsResult.message}`
        );
      }
      console.log(
        `[InventorySync] Sync complete — D365: ${d365Result.message}, GPS: ${gpsResult.message}`
      );
    });

    const result = {
      status: "success",
      inventoryItemId,
      locationId,
      available: inventory.available,
      d365Result,
      gpsResult,
      processedAt: new Date().toISOString(),
    };

    console.log(`[InventorySync] ✅ Completed: ${JSON.stringify(result)}`);
    console.log(`[InventorySync] ========================================`);

    return result;
  }
);
