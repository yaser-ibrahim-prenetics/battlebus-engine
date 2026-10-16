import type { ShopifyOrderPayload } from "../../events";
import type { WarehouseName } from "@/lib/helpers/warehouse";
import { determineWarehouse } from "@/lib/helpers/warehouse";
import { getFulfillmentOrders } from "@/lib/clients/shopify";
import {
  findLocationByWarehouseName,
  getDataAreaIdForLocationAndCountry,
  getLocationRoutingDebugContext,
  getWarehouseNameForLocation,
  resolveStordEuOverrideForMappedLocation,
  resolveStordHubWhenFulfillmentLocationUnmapped,
} from "@/lib/services/location-routing";
import { getIntendedLocationIdFromOrder, selectPreferredFulfillmentLocationId } from "./helpers";

export async function determineSubscriptionWarehouse(params: {
  step: any;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
}): Promise<{
  dataAreaId: string;
  warehouseName: WarehouseName;
  country_code: string;
  routingSource: "location";
}> {
  return params.step.run("determine-warehouse", async () => {
    const { order, shopifyOrderId, shopifyOrderName } = params;
    const countryCode =
      order.shipping_address?.country_code || order.billing_address?.country_code || "US";
    const intendedLocationId = getIntendedLocationIdFromOrder(order);
    let fulfillmentLocationId: number | undefined;

    try {
      const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
      fulfillmentLocationId =
        selectPreferredFulfillmentLocationId(fulfillmentOrders as any[]) ?? undefined;
    } catch {
      console.warn(`[Subscription] Could not fetch fulfillment orders for ${shopifyOrderName}`);
    }

    if (!fulfillmentLocationId && intendedLocationId) {
      fulfillmentLocationId = intendedLocationId;
      console.log(
        `[Subscription Routing] Using intended_location_id=${intendedLocationId} from order note attributes for ${shopifyOrderName}`
      );
    }

    if (!fulfillmentLocationId) {
      const expectedWarehouseName = determineWarehouse(countryCode);
      const hubLocation = await findLocationByWarehouseName(expectedWarehouseName, "im8");
      if (!hubLocation?.shopifyLocationId) {
        throw new Error(
          `[Subscription Routing] No Shopify fulfillment location assigned for ${shopifyOrderName} and no Battle Hub location is configured for country=${countryCode} (expected warehouse: ${expectedWarehouseName}). Configure the location in Battle Hub Locations settings.`
        );
      }
      fulfillmentLocationId = Number(hubLocation.shopifyLocationId);
      console.warn(
        `[Subscription Routing] ${shopifyOrderName}: Shopify only assigned a virtual location. Resolved to "${expectedWarehouseName}" (id=${fulfillmentLocationId}) via country=${countryCode} + Battle Hub config.`
      );
    }

    let dataAreaId = await getDataAreaIdForLocationAndCountry(
      fulfillmentLocationId,
      countryCode,
      "im8"
    );
    let warehouseName = await getWarehouseNameForLocation(fulfillmentLocationId, "im8");
    const stordEuOverride = await resolveStordEuOverrideForMappedLocation(
      warehouseName,
      countryCode,
      "im8"
    );
    if (stordEuOverride) {
      console.warn(
        `[Subscription Routing] ${shopifyOrderName}: STORD routing normalized for country=${countryCode}; location ${fulfillmentLocationId} (${warehouseName || "unknown"}) → ${stordEuOverride.hubShopifyLocationId} (${stordEuOverride.warehouseName}), dataAreaId=${stordEuOverride.dataAreaId}.`
      );
      fulfillmentLocationId = Number(stordEuOverride.hubShopifyLocationId);
      dataAreaId = stordEuOverride.dataAreaId;
      warehouseName = stordEuOverride.warehouseName;
    }

    if (
      intendedLocationId &&
      intendedLocationId !== fulfillmentLocationId &&
      String(warehouseName || "")
        .toLowerCase()
        .includes("virtual")
    ) {
      const intendedWarehouse = await getWarehouseNameForLocation(intendedLocationId, "im8");
      if (intendedWarehouse && !intendedWarehouse.toLowerCase().includes("virtual")) {
        fulfillmentLocationId = intendedLocationId;
        dataAreaId = await getDataAreaIdForLocationAndCountry(
          fulfillmentLocationId,
          countryCode,
          "im8"
        );
        warehouseName = intendedWarehouse;
      }
    }

    if (!dataAreaId || !warehouseName) {
      const stordHub = await resolveStordHubWhenFulfillmentLocationUnmapped(
        order,
        countryCode,
        "im8"
      );
      if (stordHub) {
        console.warn(
          `[Subscription Routing] ${shopifyOrderName}: fulfillment location ${fulfillmentLocationId} is not in Battle Hub; using configured "${stordHub.warehouseName}" (hub Shopify location id ${stordHub.hubShopifyLocationId}).`
        );
        fulfillmentLocationId = Number(stordHub.hubShopifyLocationId);
        dataAreaId = stordHub.dataAreaId;
        warehouseName = stordHub.warehouseName;
      }
    }

    if (!dataAreaId || !warehouseName || warehouseName.toLowerCase().includes("virtual")) {
      const context = await getLocationRoutingDebugContext(
        fulfillmentLocationId,
        countryCode,
        "im8"
      );
      throw new Error(
        `[Subscription Routing] Shopify location ${fulfillmentLocationId} is not fully configured in Battle Hub for country ${countryCode}. Configure a real warehouse and dataAreaId. Context: ${context}`
      );
    }

    console.log(
      `[Subscription Routing] Location ${fulfillmentLocationId} → warehouse: ${warehouseName}, dataAreaId: ${dataAreaId}`
    );
    return {
      dataAreaId,
      warehouseName: warehouseName as WarehouseName,
      country_code: countryCode,
      routingSource: "location" as const,
    };
  });
}
