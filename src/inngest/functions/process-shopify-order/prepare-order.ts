import * as slack from "@/lib/clients/slack";
import { getFulfillmentOrders, getVariantSkusByVariantIds } from "@/lib/clients/shopify";
import { determineWarehouse, type WarehouseName } from "@/lib/helpers/warehouse";
import {
  findLocationByWarehouseName,
  getDataAreaIdForLocationAndCountry,
  getLocationRoutingDebugContext,
  getWarehouseNameForLocation,
  resolveStordEuOverrideForMappedLocation,
  resolveStordHubWhenFulfillmentLocationUnmapped,
} from "@/lib/services/location-routing";
import { SlackChannelEnum } from "@/lib/types/slack";
import { validateOrderCompletely } from "@/lib/utils/validation";
import type { ShopifyOrderPayload } from "../../events";
import type { PublishStatus, StepTools } from "./types";

function selectPreferredFulfillmentLocationId(fulfillmentOrders: any[]): number | null {
  const activeOrders = fulfillmentOrders.filter(
    (fo: any) => fo?.status === "open" || fo?.status === "in_progress"
  );
  if (!activeOrders.length) return null;

  // Priority 1: open FOs with a real delivery method AND a non-virtual location
  const deliverable = activeOrders.filter((fo: any) => {
    const methodType = String(fo?.delivery_method?.method_type || "").toLowerCase();
    const assignedLocationName = String(fo?.assigned_location?.name || "").toLowerCase();
    return methodType !== "none" && !assignedLocationName.includes("virtual");
  });
  if (deliverable[0]?.assigned_location_id) {
    return Number(deliverable[0].assigned_location_id);
  }

  // Priority 2: any open FO whose assigned location is not virtual (ignoring delivery method)
  const nonVirtual = activeOrders.filter(
    (fo: any) =>
      !String(fo?.assigned_location?.name || "")
        .toLowerCase()
        .includes("virtual")
  );
  if (nonVirtual[0]?.assigned_location_id) {
    return Number(nonVirtual[0].assigned_location_id);
  }

  // All open FOs point to virtual — return null so caller can use intended_location_id
  return null;
}

function getIntendedLocationIdFromOrder(order: ShopifyOrderPayload): number | null {
  const attributes = Array.isArray((order as any)?.note_attributes)
    ? ((order as any).note_attributes as Array<{ name?: string; value?: string }>)
    : [];

  const getAttr = (key: string) =>
    attributes.find((a) => String(a?.name || "").toLowerCase() === key)?.value || "";

  const intendedName = getAttr("intended_location_name");
  // Skip if the noted intended location is itself virtual — it was created incorrectly
  if (intendedName && String(intendedName).toLowerCase().includes("virtual")) {
    return null;
  }

  const intendedId = getAttr("intended_location_id");
  const parsed = Number(String(intendedId).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function prepareShopifyOrder({
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  publishStatus,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  publishStatus: PublishStatus;
}) {
  await publishStatus(
    "prepare-order",
    "running",
    "Resolving SKUs, validating order, and determining warehouse routing"
  );
  return step.run("prepare-order", async () => {
    // --- 1. Resolve missing line SKUs ---
    let currentOrder = order;
    const lineItems = Array.isArray(currentOrder?.line_items) ? currentOrder.line_items : [];
    const missingShippableLines = lineItems
      .map((item: any, index: number) => ({ item, index }))
      .filter(({ item }) => {
        const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
        const requiresShipping = item?.requires_shipping !== false;
        return requiresShipping && !sku;
      });

    let skuResolution: {
      attempted: number;
      resolved: number;
      unresolved: Array<{ index: number; title: string; variantId: number | null }>;
    };

    if (missingShippableLines.length === 0) {
      skuResolution = { attempted: 0, resolved: 0, unresolved: [] };
    } else {
      const variantIds = missingShippableLines
        .map(({ item }) => Number(item?.variant_id))
        .filter((id) => Number.isFinite(id) && id > 0);

      const latestSkuByVariantId =
        variantIds.length > 0 ? await getVariantSkusByVariantIds(variantIds) : {};

      let resolved = 0;
      const patchedLineItems = lineItems.map((item: any) => {
        const currentSku = typeof item?.sku === "string" ? item.sku.trim() : "";
        const requiresShipping = item?.requires_shipping !== false;
        if (!requiresShipping || currentSku) return item;

        const variantId = Number(item?.variant_id);
        const latestSku =
          Number.isFinite(variantId) && variantId > 0
            ? latestSkuByVariantId[String(Math.trunc(variantId))]
            : "";
        if (!latestSku) return item;
        resolved += 1;
        return { ...item, sku: latestSku };
      });

      const unresolved = patchedLineItems
        .map((item: any, index: number) => ({ item, index }))
        .filter(({ item }) => {
          const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
          const requiresShipping = item?.requires_shipping !== false;
          return requiresShipping && !sku;
        })
        .map(({ item, index }) => ({
          index,
          title: item?.title || "untitled",
          variantId:
            Number.isFinite(Number(item?.variant_id)) && Number(item?.variant_id) > 0
              ? Number(item?.variant_id)
              : null,
        }));

      currentOrder = { ...currentOrder, line_items: patchedLineItems } as ShopifyOrderPayload;
      skuResolution = { attempted: missingShippableLines.length, resolved, unresolved };
    }

    // --- Handle unresolved SKUs ---
    if (skuResolution.unresolved.length > 0) {
      const lineItemsAfterPatch = Array.isArray(currentOrder?.line_items)
        ? currentOrder.line_items
        : [];
      const unresolvedIdx = new Set(
        skuResolution.unresolved.map((u: { index: number }) => u.index)
      );
      const filteredLineItems = lineItemsAfterPatch.filter((_, idx) => !unresolvedIdx.has(idx));

      const hasShippableWithSku = filteredLineItems.some((item: any) => {
        const sku = typeof item?.sku === "string" ? item.sku.trim() : "";
        const requiresShipping = item?.requires_shipping !== false;
        return requiresShipping && !!sku;
      });

      const unresolvedSummary = skuResolution.unresolved
        .slice(0, 5)
        .map(
          (l: { index: number; title: string; variantId: number | null }) =>
            `${l.title} (line=${l.index}, variant=${l.variantId ?? "n/a"})`
        )
        .join(", ");

      if (!hasShippableWithSku) {
        await publishStatus(
          "resolve-line-skus",
          "failed",
          `Unable to resolve SKU for ${skuResolution.unresolved.length} shippable line(s)`
        );
        throw new Error(
          `[D365] Missing SKU/ItemNumber after Shopify variant refresh for ${shopifyOrderName}; ` +
            `attempted=${skuResolution.attempted}; resolved=${skuResolution.resolved}; ` +
            `unresolved=${skuResolution.unresolved.length}; sample=${unresolvedSummary}`
        );
      }

      console.warn(
        `[Order] Excluding ${skuResolution.unresolved.length} shippable line(s) with no SKU in Shopify ` +
          `(GraphQL variant has empty SKU). Remaining lines go to D365/GPS. Sample: ${unresolvedSummary}`
      );
      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        `Order ${shopifyOrderName}: excluded ${skuResolution.unresolved.length} shippable line(s) without ItemNumber in Shopify — processing remaining SKUs only. Sample: ${unresolvedSummary}`
      );

      currentOrder = { ...currentOrder, line_items: filteredLineItems } as ShopifyOrderPayload;
      await publishStatus(
        "resolve-line-skus",
        "completed",
        skuResolution.resolved > 0
          ? `Resolved ${skuResolution.resolved} line(s); excluded ${skuResolution.unresolved.length} unresolvable line(s)`
          : `Excluded ${skuResolution.unresolved.length} shippable line(s) with empty variant SKU; remaining lines proceed`
      );
    } else {
      await publishStatus(
        "resolve-line-skus",
        "completed",
        skuResolution.resolved > 0
          ? `Resolved ${skuResolution.resolved} missing SKU line(s) from Shopify variants`
          : "No missing shippable SKUs found"
      );
    }

    // --- 2. Validate order ---
    await publishStatus("validate-order", "running", "Validating order");
    const validation = await validateOrderCompletely(
      currentOrder,
      shopifyOrderId,
      shopifyOrderName
    );

    if (!validation.valid || validation.skip) {
      return { type: "validation_failed" as const, validation, updatedOrder: currentOrder };
    }

    await publishStatus("validate-order", "completed", "Order validation passed");

    // --- 3. Determine warehouse routing ---
    const countryCode =
      currentOrder.shipping_address?.country_code ||
      currentOrder.billing_address?.country_code ||
      "US";

    const intendedLocationId = getIntendedLocationIdFromOrder(currentOrder);

    let fulfillmentLocationId: number | null = null;
    try {
      const fulfillmentOrders = await getFulfillmentOrders(Number(shopifyOrderId));
      fulfillmentLocationId = selectPreferredFulfillmentLocationId(fulfillmentOrders as any[]);
    } catch (error) {
      console.warn(`[Order Routing] Could not fetch fulfillment orders: ${error}`);
    }

    if (!fulfillmentLocationId && intendedLocationId) {
      fulfillmentLocationId = intendedLocationId;
      console.log(
        `[Order Routing] Using intended_location_id=${intendedLocationId} from order note attributes for ${shopifyOrderName}`
      );
    }

    if (!fulfillmentLocationId) {
      const expectedWarehouseName = determineWarehouse(countryCode);
      const hubLocation = await findLocationByWarehouseName(expectedWarehouseName, "im8");
      if (hubLocation?.shopifyLocationId) {
        fulfillmentLocationId = Number(hubLocation.shopifyLocationId);
        console.warn(
          `[Order Routing] ${shopifyOrderName}: Shopify only assigned a virtual location. ` +
            `Resolved to "${expectedWarehouseName}" (id=${fulfillmentLocationId}) via country=${countryCode} + Battle Hub config.`
        );
      } else {
        throw new Error(
          `[Order Routing] No Shopify fulfillment location assigned for ${shopifyOrderName} and no Battle Hub location is configured for country=${countryCode} (expected warehouse: ${expectedWarehouseName}). ` +
            `Configure the location in Battle Hub Locations settings.`
        );
      }
    }

    let locationDataAreaId = await getDataAreaIdForLocationAndCountry(
      fulfillmentLocationId,
      countryCode,
      "im8"
    );
    let warehouseNameFromLocation = await getWarehouseNameForLocation(fulfillmentLocationId, "im8");

    const stordEuOverride = await resolveStordEuOverrideForMappedLocation(
      warehouseNameFromLocation,
      countryCode,
      "im8"
    );
    if (stordEuOverride) {
      const originalLocationId = fulfillmentLocationId;
      const originalWarehouseName = warehouseNameFromLocation;
      fulfillmentLocationId = Number(stordEuOverride.hubShopifyLocationId);
      locationDataAreaId = stordEuOverride.dataAreaId;
      warehouseNameFromLocation = stordEuOverride.warehouseName;
      console.warn(
        `[Order Routing] ${shopifyOrderName}: STORD routing normalized for country=${countryCode}; ` +
          `location ${originalLocationId} (${originalWarehouseName || "unknown"}) → ` +
          `${stordEuOverride.hubShopifyLocationId} (${stordEuOverride.warehouseName}), ` +
          `dataAreaId=${stordEuOverride.dataAreaId}.`
      );
    }

    if (
      intendedLocationId &&
      intendedLocationId !== fulfillmentLocationId &&
      String(warehouseNameFromLocation || "")
        .toLowerCase()
        .includes("virtual")
    ) {
      const intendedWarehouse = await getWarehouseNameForLocation(intendedLocationId, "im8");
      if (intendedWarehouse && !String(intendedWarehouse).toLowerCase().includes("virtual")) {
        fulfillmentLocationId = intendedLocationId;
        locationDataAreaId = await getDataAreaIdForLocationAndCountry(
          fulfillmentLocationId,
          countryCode,
          "im8"
        );
        warehouseNameFromLocation = intendedWarehouse;
        console.log(
          `[Order Routing] Switched from virtual location to intended_location_id=${intendedLocationId} for ${shopifyOrderName}`
        );
      }
    }

    if (!locationDataAreaId || !warehouseNameFromLocation) {
      const stordHub = await resolveStordHubWhenFulfillmentLocationUnmapped(
        currentOrder,
        countryCode,
        "im8"
      );
      if (stordHub) {
        const unknownLoc = fulfillmentLocationId;
        locationDataAreaId = stordHub.dataAreaId;
        warehouseNameFromLocation = stordHub.warehouseName;
        fulfillmentLocationId = Number(stordHub.hubShopifyLocationId);
        console.warn(
          `[Order Routing] ${shopifyOrderName}: fulfillment location ${unknownLoc} is not in Battle Hub; ` +
            `all lines use fulfillment_service=stord — using configured "${stordHub.warehouseName}" ` +
            `(hub Shopify location id ${stordHub.hubShopifyLocationId}). ` +
            `Add or update this location in Battle Hub (shopify_location_id=${unknownLoc}) so routing stays explicit.`
        );
      }
    }

    if (!locationDataAreaId || !warehouseNameFromLocation) {
      const routingContext = await getLocationRoutingDebugContext(
        fulfillmentLocationId,
        countryCode,
        "im8"
      );
      throw new Error(
        `[Order Routing] Shopify location ${fulfillmentLocationId} is not fully configured in Battle Hub for country ${countryCode}. Set the location warehouse name and dataAreaId/country override in Locations; country fallback is disabled. Context: ${routingContext}`
      );
    }

    if (String(warehouseNameFromLocation).toLowerCase().includes("virtual")) {
      const routingContext = await getLocationRoutingDebugContext(
        fulfillmentLocationId,
        countryCode,
        "im8"
      );
      throw new Error(
        `[Order Routing] Unsupported virtual warehouse "${warehouseNameFromLocation}" for Shopify location ${fulfillmentLocationId}. Configure a real fulfillment location in Shopify and Battle Hub. Context: ${routingContext}`
      );
    }

    console.log(
      `[Order Routing] Location ${fulfillmentLocationId} + country ${countryCode} → warehouse: ${warehouseNameFromLocation}, dataAreaId: ${locationDataAreaId}`
    );

    return {
      type: "ready" as const,
      validation,
      updatedOrder: currentOrder,
      routingResult: {
        warehouseName: warehouseNameFromLocation as WarehouseName,
        dataAreaId: locationDataAreaId,
        countryCode,
        routingSource: "location" as const,
      },
    };
  });
}

export type PrepareOrderResult = Awaited<ReturnType<typeof prepareShopifyOrder>>;
