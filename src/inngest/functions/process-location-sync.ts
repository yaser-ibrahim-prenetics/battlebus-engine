// ============================================================================
// SHOPIFY LOCATION → SUPABASE + BATTLE HUB SYNC
// ============================================================================
// Processes Shopify location create/update/delete webhooks.
//
// On create/update:
//   1. Auto-detect warehouse + dataAreaId from the location *name* string and
//      *country code* in the Shopify payload.  No hardcoded location IDs.
//   2. Upsert into Supabase `locations` table:
//      - CREATE: writes auto-detected warehouse/dataAreaId as defaults
//      - UPDATE: preserves existing routing config (never overwrites manual edits)
//   3. Notify Battle Hub via CS Platform event
//   4. Invalidate routing cache
//
// On delete:
//   1. Soft-delete in Supabase (active = false)
//   2. Notify Battle Hub
//
// SEEDING: Use GET /api/locations/seed to pull all Shopify locations at once.

import { inngest } from "../client";
import * as csPlatform from "@/lib/clients/cs-platform";
import {
  upsertLocation,
  deactivateLocation,
} from "@/lib/services/location-routing";
import { resolveCountryRouting, getDataAreaId } from "@/lib/helpers/warehouse";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

// ============================================================================
// Name-based heuristics (no hardcoded IDs)
// ============================================================================

function inferWarehouseFromName(name: string): string | null {
  const n = (name || "").toLowerCase();
  if (n.includes("gps") && (n.includes("uk") || n.includes("london") || n.includes("lhr"))) {
    return "GPS UK Warehouse";
  }
  if (n.includes("gps")) return "GPS Warehouse";
  if (n.includes("stord")) return "STORD ATL Location";
  if (n.includes("hk") || n.includes("hong kong")) return "HK Warehouse";
  return null;
}

// ============================================================================
// Inngest function
// ============================================================================

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
    const isCreate = event.name === "shopify/location.created";
    const isDelete = event.name === "shopify/location.deleted";

    console.log(`[LocationSync] ========================================`);
    console.log(
      `[LocationSync] ${event.name} | "${locationName}" (${locationId}) | store: ${shopifyStore}`
    );

    // =========================================================================
    // DELETION
    // =========================================================================
    if (isDelete) {
      await step.run("deactivate-in-supabase", async () => {
        await deactivateLocation(String(locationId));
      });

      await step.run("notify-hub-deleted", async () => {
        try {
          await csPlatform.sendLocationEvent({
            event: "location.deleted",
            data: { id: locationId, name: locationName || "Unknown", shopify_location_id: locationId },
          });
        } catch (err) {
          console.error("[LocationSync] Failed to notify Hub of deletion:", err);
        }
      });

      return { status: "deleted", locationId, locationName, processedAt: new Date().toISOString() };
    }

    // =========================================================================
    // AUTO-DETECT warehouse + dataAreaId
    // Priority:
    //   1. Location name string (e.g. "GPS UK Warehouse" → GPS UK)
    //   2. Country code from the Shopify location payload → warehouse config
    //
    // No env-var location IDs.  The user configures routing manually in Hub
    // when auto-detection is uncertain.
    // =========================================================================
    const detectedWarehouseName = await step.run("detect-warehouse", async () => {
      // 1. Name heuristic
      const byName = inferWarehouseFromName(locationName || "");
      if (byName) {
        console.log(`[LocationSync] Name heuristic → "${byName}"`);
        return byName;
      }

      // 2. Country code
      const countryCode =
        locationJson?.country_code ||
        locationJson?.country ||
        null;
      if (countryCode) {
        const routing = resolveCountryRouting(countryCode);
        console.log(
          `[LocationSync] Country "${countryCode}" → warehouse "${routing.warehouseName}"`
        );
        return routing.warehouseName;
      }

      console.log("[LocationSync] Could not auto-detect warehouse — user must set in Hub");
      return null;
    });

    const detectedDataAreaId = await step.run("detect-data-area-id", async () => {
      if (detectedWarehouseName) {
        try {
          return getDataAreaId(detectedWarehouseName);
        } catch {
          // warehouse not in config — fall through
        }
      }
      return null;
    });

    console.log(
      `[LocationSync] Auto-detected: warehouse="${detectedWarehouseName}", dataAreaId="${detectedDataAreaId}"`
    );

    // =========================================================================
    // UPSERT INTO SUPABASE
    // =========================================================================
    await step.run("upsert-supabase", async () => {
      await upsertLocation({
        shopifyLocationId: String(locationId),
        name: locationName,
        addressLine1: locationJson?.address1 ?? null,
        addressLine2: locationJson?.address2 ?? null,
        city: locationJson?.city ?? null,
        province: locationJson?.province ?? null,
        country: locationJson?.country ?? null,
        zip: locationJson?.zip ?? null,
        phone: locationJson?.phone ?? null,
        active: locationJson?.active !== false,
        fulfillmentServiceId: locationJson?.fulfillment_service_id
          ? String(locationJson.fulfillment_service_id)
          : null,
        defaultWarehouseName: detectedWarehouseName,
        defaultDataAreaId: detectedDataAreaId,
        isCreate,
      });
    });

    // =========================================================================
    // NOTIFY BATTLE HUB
    // =========================================================================
    await step.run("notify-hub", async () => {
      try {
        await csPlatform.sendLocationEvent({
          event: isCreate ? "location.created" : "location.updated",
          data: {
            id: locationId,
            name: locationName,
            shopify_location_id: locationId,
            warehouse_name: detectedWarehouseName,
            dynamics_data_area_id: detectedDataAreaId,
            address_line1: locationJson?.address1 ?? null,
            address_line2: locationJson?.address2 ?? null,
            city: locationJson?.city ?? null,
            province: locationJson?.province ?? null,
            country: locationJson?.country ?? null,
            zip: locationJson?.zip ?? null,
            phone: locationJson?.phone ?? null,
            active: locationJson?.active !== false,
            fulfillment_service_id: locationJson?.fulfillment_service_id
              ? String(locationJson.fulfillment_service_id)
              : null,
          },
        });
      } catch (err) {
        console.error("[LocationSync] Failed to notify Hub:", err);
      }
    });

    const result = {
      status: "success",
      locationId,
      locationName,
      warehouseName: detectedWarehouseName,
      dataAreaId: detectedDataAreaId,
      event: event.name,
      processedAt: new Date().toISOString(),
    };

    console.log(`[LocationSync] ✅ ${JSON.stringify(result)}`);
    console.log(`[LocationSync] ========================================`);
    return result;
  }
);
