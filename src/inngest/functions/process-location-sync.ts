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
import { resolveCountryRouting } from "@/lib/helpers/warehouse";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

// Location name from Shopify is the warehouse (no separate warehouse field).
// We only auto-detect a default dataAreaId for new rows; user sets data area in Hub.

function inferDataAreaFromNameAndCountry(name: string, countryCode: string | null): string | null {
  const n = (name || "").toLowerCase();
  if (n.includes("gps") && (n.includes("uk") || n.includes("london") || n.includes("lhr"))) return "H007";
  if (n.includes("gps")) return "U001";
  if (n.includes("stord")) return "U001";
  if (n.includes("hk") || n.includes("hong kong")) return "H005";
  if (countryCode) {
    const routing = resolveCountryRouting(countryCode);
    return routing.dataAreaId;
  }
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

    // Location itself is the warehouse — use location name. Only auto-detect default dataAreaId.
    const countryCode =
      locationJson?.country_code || locationJson?.country || null;
    const detectedDataAreaId = await step.run("detect-data-area-id", async () => {
      return inferDataAreaFromNameAndCountry(locationName || "", countryCode);
    });

    console.log(
      `[LocationSync] Location="${locationName}" (warehouse = location). Default dataAreaId="${detectedDataAreaId}"`
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
        defaultWarehouseName: locationName, // location itself is the warehouse
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
            warehouse_name: locationName,
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
      dataAreaId: detectedDataAreaId,
      event: event.name,
      processedAt: new Date().toISOString(),
    };

    console.log(`[LocationSync] ✅ ${JSON.stringify(result)}`);
    console.log(`[LocationSync] ========================================`);
    return result;
  }
);
