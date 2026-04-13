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
import { upsertLocation, deactivateLocation } from "@/lib/services/location-routing";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

// Location name from Shopify is the warehouse (no separate warehouse field).
// Data area must be configured explicitly in Battle Hub. Do not infer defaults here.

// ============================================================================
// Inngest function
// ============================================================================

export const processLocationSync = inngest.createFunction(
  {
    id: "process-location-sync",
    name: "Process Shopify Location Sync",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: [{ limit: 5 }],
    triggers: [
      { event: "shopify/location.created" },
      { event: "shopify/location.updated" },
      { event: "shopify/location.deleted" },
    ],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;
    const { locationId, locationName, shopifyStore, locationJson } = event.data;
    const isCreate = event.name === "shopify/location.created";
    const isDelete = event.name === "shopify/location.deleted";

    await logFlowEvent({
      flow: "location_sync",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { locationId, locationName, shopifyStore, eventName: event.name },
    });

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
            data: {
              id: locationId,
              name: locationName || "Unknown",
              shopify_location_id: locationId,
            },
          });
        } catch (err) {
          console.error("[LocationSync] Failed to notify Hub of deletion:", err);
        }
      });

      await logFlowEvent({
        flow: "location_sync",
        step: "done",
        status: "completed",
        runId: _runId,
        durationMs: Date.now() - _flowStart,
        shopifyOrderId: event.data?.shopifyOrderId,
        shopifyOrderName: event.data?.shopifyOrderName,
        payload: { locationId, locationName, shopifyStore, deleted: true },
      });

      return { status: "deleted", locationId, locationName, processedAt: new Date().toISOString() };
    }

    // Location itself is the warehouse. Data area must be configured in Battle Hub.
    const detectedDataAreaId: string | undefined = undefined;

    console.log(
      `[LocationSync] Location="${locationName}" (warehouse = location). Default dataAreaId is blank until configured in Battle Hub.`
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

    await logFlowEvent({
      flow: "location_sync",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      shopifyOrderId: event.data?.shopifyOrderId,
      shopifyOrderName: event.data?.shopifyOrderName,
      payload: { locationId, locationName, shopifyStore, eventName: event.name },
    });

    return result;
  }
);
