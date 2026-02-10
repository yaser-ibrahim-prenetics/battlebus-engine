// ============================================================================
// SHOPIFY LOCATION → BATTLE HUB SYNC
// ============================================================================
// Processes Shopify location create/update/delete webhooks
// Syncs location data to Battle Hub with warehouse mapping and dataAreaId

import { inngest } from "../client";
import * as csPlatform from "@/lib/clients/cs-platform";
import { getDataAreaIdFromLocation, getWarehouseNameFromLocation } from "@/lib/utils/validation";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

export const processLocationSync = inngest.createFunction(
  {
    id: "process-location-sync",
    name: "Process Shopify Location Sync",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
  },
  [
    { event: "shopify/location.created" },
    { event: "shopify/location.updated" },
    { event: "shopify/location.deleted" },
  ],
  async ({ event, step }: { event: any; step: any }) => {
    const { locationId, locationName, shopifyStore, locationJson } = event.data;

    console.log(`[LocationSync] ========================================`);
    console.log(`[LocationSync] Processing location: ${locationName} (${locationId}) from ${shopifyStore}`);
    console.log(`[LocationSync] Event: ${event.name}`);

    // Handle deletion
    if (event.name === "shopify/location.deleted") {
      await step.run("notify-battle-hub-location-deleted", async () => {
        console.log(`[LocationSync] Notifying Battle Hub of location deletion...`);
        await csPlatform.sendLocationEvent({
          event: "location.deleted",
          data: {
            id: locationId,
            name: locationName || "Unknown",
            shopify_location_id: locationId,
          },
        });
      });

      return {
        status: "deleted",
        locationId,
        locationName,
        processedAt: new Date().toISOString(),
      };
    }

    // Get warehouse mapping and dataAreaId
    const warehouseName = getWarehouseNameFromLocation(locationId, locationName);
    const dataAreaId = getDataAreaIdFromLocation(locationId);

    console.log(`[LocationSync] Warehouse: ${warehouseName}`);
    console.log(`[LocationSync] Data Area ID: ${dataAreaId}`);

    // Notify Battle Hub
    await step.run("notify-battle-hub-location-sync", async () => {
      const isCreate = event.name === "shopify/location.created";
      const locationData = {
        id: locationId,
        name: locationName,
        shopify_location_id: locationId,
        warehouse_name: warehouseName,
        dynamics_data_area_id: dataAreaId,
        address_line1: locationJson.address1 || null,
        address_line2: locationJson.address2 || null,
        city: locationJson.city || null,
        province: locationJson.province || null,
        country: locationJson.country || null,
        zip: locationJson.zip || null,
        phone: locationJson.phone || null,
        active: locationJson.active !== false,
        fulfillment_service_id: locationJson.fulfillment_service_id
          ? String(locationJson.fulfillment_service_id)
          : null,
      };

      try {
        await csPlatform.sendLocationEvent({
          event: isCreate ? "location.created" : "location.updated",
          data: locationData,
        });
      } catch (error) {
        // Don't throw - Battle Hub notification failure shouldn't break the sync
        console.error(`[LocationSync] Failed to notify Battle Hub:`, error);
      }
    });

    const result = {
      status: "success",
      locationId,
      locationName,
      warehouseName,
      dataAreaId,
      event: event.name,
      processedAt: new Date().toISOString(),
    };

    console.log(`[LocationSync] ✅ Completed: ${JSON.stringify(result)}`);
    console.log(`[LocationSync] ========================================`);

    return result;
  }
);

