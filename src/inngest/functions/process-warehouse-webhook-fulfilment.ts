import crypto from "node:crypto";
import { NonRetriableError } from "inngest";

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import { determineWarehouse, isValidGpsWarehouse } from "@/lib/helpers/warehouse";
import { getTrackingUrl, mapGpsCarrierToShopify } from "@/lib/helpers/tracking";
import {
  getLocationIdForWarehouse,
  stordWarehouseNameForShipCountry,
} from "@/lib/services/location-routing";
import type {
  ShopifyFulfillment,
  ShopifyFulfillmentLineItem,
  ShopifyOrderPayload,
} from "../events";
import type { IFulfillmentOrderLineItem, IShopifyFulfillmentOrder } from "@/lib/types/shopify";

type WarehouseWebhookSource = "gps" | "stord";

type WarehouseWebhookEvent = {
  id?: string;
  name: "gps/fulfilment.received" | "stord/fulfilment.received";
  data: {
    gpsOrderId?: string;
    stordOrderId?: string;
    shopifyOrderId?: string;
    trackingNumber?: string;
    carrierCode?: string;
    fulfilmentJson?: unknown;
    receivedAt?: string;
  };
};

type WarehouseStep = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  sendEvent: (name: string, event: Record<string, unknown>) => Promise<unknown>;
};

type NormalizedItem = {
  sku: string;
  quantity: number;
};

type NormalizedWarehouseFulfilment = {
  source: WarehouseWebhookSource;
  warehouseOrderId: string;
  shopifyReferenceCandidates: string[];
  trackingNumber: string;
  carrier: string;
  shippedAt: string;
  warehouseHint: string;
  warehouseCode: string;
  items: NormalizedItem[];
};

type ShopifyOrderWithFulfillments = ShopifyOrderPayload & {
  fulfillments?: ShopifyFulfillment[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function positiveQuantity(...values: unknown[]): number {
  for (const value of values) {
    const quantity = Number(value);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return 0;
}

function normalizeItems(raw: Record<string, unknown>): NormalizedItem[] {
  const candidates = [raw.items, raw.lineItems, raw.productList];
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];

  return list
    .map((value): NormalizedItem | null => {
      const item = asRecord(value);
      const sku = firstString(item.sku, item.itemNumber, item.productCode, item.skuCode);
      const quantity = positiveQuantity(
        item.quantityShipped,
        item.realQuantity,
        item.quantity,
        item.qty
      );
      return sku && quantity > 0 ? { sku, quantity } : null;
    })
    .filter((item): item is NormalizedItem => item !== null);
}

function normalizeWebhookEvent(event: WarehouseWebhookEvent): NormalizedWarehouseFulfilment {
  const source: WarehouseWebhookSource = event.name.startsWith("gps/") ? "gps" : "stord";
  const envelope = asRecord(event.data.fulfilmentJson);
  const nestedOrderData = asRecord(envelope.orderData);
  const raw = { ...envelope, ...nestedOrderData };

  const warehouseOrderId = firstString(
    source === "gps" ? event.data.gpsOrderId : event.data.stordOrderId,
    raw.outboundOrderNo,
    raw.orderId,
    raw.id,
    raw.orderNumber
  );
  const trackingNumber = firstString(
    event.data.trackingNumber,
    raw.trackingNumber,
    raw.logisticsTrackNo,
    asRecord(raw.tracking).number,
    Array.isArray(raw.logisticsTrackNos) ? raw.logisticsTrackNos[0] : ""
  );
  const carrier = firstString(
    event.data.carrierCode,
    raw.carrierCode,
    raw.carrier,
    raw.logisticsCarrier,
    asRecord(raw.tracking).carrier,
    source.toUpperCase()
  );
  const shippedAt = firstString(
    raw.shippedAt,
    raw.shippedDate,
    raw.outboundTime,
    event.data.receivedAt,
    new Date().toISOString()
  );
  const warehouseHint = firstString(raw.warehouse, raw.warehouseName, raw.locationName);
  const warehouseCode = firstString(raw.whCode, raw.warehouseCode);
  const shopifyReferenceCandidates = Array.from(
    new Set(
      [
        event.data.shopifyOrderId,
        raw.shopifyOrderId,
        raw.platformOrderNo,
        raw.shopifyOrderName,
        raw.externalOrderId,
        raw.orderNumber,
      ]
        .map((value) => firstString(value))
        .filter(Boolean)
    )
  );

  if (!warehouseOrderId) {
    throw new NonRetriableError(
      `${source.toUpperCase()} webhook is missing its warehouse order ID`
    );
  }
  if (!trackingNumber) {
    throw new NonRetriableError(
      `${source.toUpperCase()} webhook ${warehouseOrderId} is missing a tracking number`
    );
  }
  if (shopifyReferenceCandidates.length === 0) {
    throw new NonRetriableError(
      `${source.toUpperCase()} webhook ${warehouseOrderId} has no Shopify order reference`
    );
  }

  return {
    source,
    warehouseOrderId,
    shopifyReferenceCandidates,
    trackingNumber,
    carrier,
    shippedAt,
    warehouseHint,
    warehouseCode,
    items: normalizeItems(raw),
  };
}

function numericShopifyOrderId(reference: string): number | null {
  const gidMatch = reference.match(/gid:\/\/shopify\/Order\/(\d+)$/i);
  const normalized = gidMatch?.[1] ?? reference;
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function resolveShopifyOrder(references: string[]): Promise<ShopifyOrderWithFulfillments> {
  const failures: string[] = [];

  for (const reference of references) {
    const orderId = numericShopifyOrderId(reference);
    try {
      if (orderId) {
        return (await shopify.getOrder(orderId)) as ShopifyOrderWithFulfillments;
      }

      const matches = await shopify.searchOrdersByName(reference);
      const exact = matches.find(
        (order) => String(order.name || "").replace(/^#/, "") === reference.replace(/^#/, "")
      );
      if (exact || matches[0]) {
        return (exact || matches[0]) as unknown as ShopifyOrderWithFulfillments;
      }
      failures.push(`${reference}: not found`);
    } catch (error) {
      failures.push(`${reference}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Shopify order could not be resolved (${failures.join("; ")})`);
}

function resolveGpsWarehouse(
  fulfilment: NormalizedWarehouseFulfilment,
  order: ShopifyOrderPayload
): "GPS Warehouse" | "GPS UK Warehouse" {
  if (isValidGpsWarehouse(fulfilment.warehouseHint)) {
    return fulfilment.warehouseHint as "GPS Warehouse" | "GPS UK Warehouse";
  }

  const code = fulfilment.warehouseCode.toUpperCase();
  if (code && code === String(config.gpsUk.warehouseCode || "").toUpperCase()) {
    return "GPS UK Warehouse";
  }
  if (code && code === String(config.gps.warehouseCode || "").toUpperCase()) {
    return "GPS Warehouse";
  }

  const countryWarehouse = determineWarehouse(order.shipping_address?.country_code || "");
  return isValidGpsWarehouse(countryWarehouse)
    ? (countryWarehouse as "GPS Warehouse" | "GPS UK Warehouse")
    : "GPS Warehouse";
}

function resolveWarehouseName(
  fulfilment: NormalizedWarehouseFulfilment,
  order: ShopifyOrderPayload
): string {
  if (fulfilment.source === "gps") return resolveGpsWarehouse(fulfilment, order);

  const hint = fulfilment.warehouseHint.toLowerCase();
  if (hint.includes("stord") && hint.includes("eu")) return "STORD EU Location";
  if (hint.includes("stord")) return "STORD ATL Location";
  return stordWarehouseNameForShipCountry(order.shipping_address?.country_code || "US");
}

function selectOpenFulfillmentOrder(
  fulfillmentOrders: IShopifyFulfillmentOrder[],
  locationId: number
): IShopifyFulfillmentOrder | null {
  const open = fulfillmentOrders.filter(
    (order) => order.status === "open" || order.status === "in_progress"
  );
  return (
    open.find(
      (order) =>
        Number(order.assigned_location_id || order.assigned_location?.location_id) === locationId
    ) ??
    open[0] ??
    null
  );
}

function requestedQuantityBySku(items: NormalizedItem[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const key = item.sku.trim().toUpperCase();
    result.set(key, (result.get(key) ?? 0) + item.quantity);
  }
  return result;
}

function fulfillmentLineItems(
  order: ShopifyOrderPayload,
  fulfillmentOrder: IShopifyFulfillmentOrder | null,
  items: NormalizedItem[]
): ShopifyFulfillmentLineItem[] {
  const requested = requestedQuantityBySku(items);
  const orderLines = Array.isArray(order.line_items) ? order.line_items : [];
  const fulfillmentOrderLines = fulfillmentOrder?.line_items ?? [];
  const sourceLines: Array<{
    lineItem: ShopifyOrderPayload["line_items"][number];
    fulfillmentOrderLine?: IFulfillmentOrderLineItem;
  }> = fulfillmentOrderLines.length
    ? fulfillmentOrderLines
        .map((line) => ({
          lineItem: orderLines.find((item) => Number(item.id) === Number(line.line_item_id)),
          fulfillmentOrderLine: line,
        }))
        .filter(
          (
            entry
          ): entry is {
            lineItem: ShopifyOrderPayload["line_items"][number];
            fulfillmentOrderLine: IFulfillmentOrderLineItem;
          } => Boolean(entry.lineItem)
        )
    : orderLines.map((lineItem) => ({ lineItem }));

  return sourceLines
    .map(({ lineItem, fulfillmentOrderLine }): ShopifyFulfillmentLineItem | null => {
      const skuKey = String(lineItem.sku || "")
        .trim()
        .toUpperCase();
      const requestedQuantity = requested.get(skuKey);
      if (requested.size > 0 && !requestedQuantity) return null;

      const availableQuantity = fulfillmentOrderLine
        ? positiveQuantity(fulfillmentOrderLine.fulfillable_quantity, fulfillmentOrderLine.quantity)
        : positiveQuantity(lineItem.quantity);
      const quantity = requestedQuantity
        ? Math.min(requestedQuantity, availableQuantity || requestedQuantity)
        : availableQuantity;
      if (quantity <= 0) return null;

      if (requestedQuantity) {
        requested.set(skuKey, Math.max(0, requestedQuantity - quantity));
      }

      return {
        id: Number(lineItem.id),
        variant_id: Number(lineItem.variant_id || 0),
        title: String(lineItem.title || ""),
        quantity,
        sku: String(lineItem.sku || ""),
        name: String(lineItem.name || lineItem.title || ""),
        price: String(lineItem.price || "0"),
        fulfillment_status: "fulfilled",
      };
    })
    .filter((item): item is ShopifyFulfillmentLineItem => item !== null);
}

function matchingExistingFulfillment(
  order: ShopifyOrderWithFulfillments,
  trackingNumber: string
): ShopifyFulfillment | null {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  return (
    fulfillments.find((fulfillment) => {
      const numbers = [fulfillment.tracking_number, ...(fulfillment.tracking_numbers || [])]
        .map((number) => String(number || "").trim())
        .filter(Boolean);
      return numbers.includes(trackingNumber);
    }) ?? null
  );
}

function stableEventSuffix(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

export async function runProcessWarehouseWebhookFulfilment({
  event,
  step,
}: {
  event: WarehouseWebhookEvent;
  step: WarehouseStep;
}) {
  const fulfilment = normalizeWebhookEvent(event);
  const featureEnabled =
    fulfilment.source === "gps" ? config.features.enableGpsSync : config.features.enableStordSync;

  if (!featureEnabled) {
    return {
      status: "skipped",
      source: fulfilment.source,
      reason: `${fulfilment.source}_sync_disabled`,
    };
  }

  const order = await step.run("resolve-shopify-order", () =>
    resolveShopifyOrder(fulfilment.shopifyReferenceCandidates)
  );
  const warehouseName = resolveWarehouseName(fulfilment, order);
  const locationId = await step.run("resolve-shopify-location", async () => {
    const dynamicLocationId = await getLocationIdForWarehouse(warehouseName);
    const fallback =
      warehouseName === "GPS UK Warehouse"
        ? config.shopify.im8.locations.gpsUk
        : warehouseName === "GPS Warehouse"
          ? config.shopify.im8.locations.gps
          : warehouseName === "STORD ATL Location"
            ? config.shopify.im8.locations.stord
            : "";
    const resolved = Number(dynamicLocationId || fallback || 0);
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new NonRetriableError(
        `No Shopify location is configured for ${warehouseName}; cannot consume ${event.name}`
      );
    }
    return resolved;
  });

  const existingFulfillment = matchingExistingFulfillment(order, fulfilment.trackingNumber);
  const fulfillmentOrder = existingFulfillment
    ? null
    : await step.run("get-shopify-fulfillment-order", async () => {
        const orders = await shopify.getFulfillmentOrders(order.id);
        return selectOpenFulfillmentOrder(orders, locationId);
      });
  const lineItems = existingFulfillment?.line_items?.length
    ? existingFulfillment.line_items
    : fulfillmentLineItems(order, fulfillmentOrder, fulfilment.items);
  if (lineItems.length === 0) {
    throw new NonRetriableError(
      `${fulfilment.source.toUpperCase()} webhook ${fulfilment.warehouseOrderId} did not match any Shopify order lines`
    );
  }

  const trackingCompany =
    fulfilment.source === "gps"
      ? mapGpsCarrierToShopify(fulfilment.carrier)
      : fulfilment.carrier || "Other";
  const trackingUrl = getTrackingUrl(fulfilment.carrier, fulfilment.trackingNumber);
  const canWriteToShopify =
    config.features.enableShopifyFulfillmentWriteback && !config.features.dryRunMode;

  const createdFulfillment =
    !existingFulfillment && fulfillmentOrder && canWriteToShopify
      ? await step.run("create-shopify-fulfillment", () =>
          shopify.createFulfillment(
            fulfillmentOrder.id,
            {
              number: fulfilment.trackingNumber,
              company: trackingCompany,
              url: trackingUrl,
            },
            fulfillmentOrder.line_items
              .filter((item) =>
                lineItems.some((line) => Number(line.id) === Number(item.line_item_id))
              )
              .map((item) => ({
                id: item.id,
                quantity:
                  lineItems.find((line) => Number(line.id) === Number(item.line_item_id))
                    ?.quantity ?? item.fulfillable_quantity,
              })),
            `${fulfilment.source}_webhook`,
            fulfilment.source.toUpperCase(),
            { notifyCustomer: true }
          )
        )
      : null;

  const eventSuffix = stableEventSuffix(
    fulfilment.source,
    fulfilment.warehouseOrderId,
    fulfilment.trackingNumber
  );
  const syntheticFulfillmentId = Number.parseInt(eventSuffix.slice(0, 12), 16);
  const sourceFulfillment = existingFulfillment || createdFulfillment;
  const sourceFulfillmentRecord = asRecord(sourceFulfillment);
  const canonicalFulfillment: ShopifyFulfillment = {
    id: Number(sourceFulfillmentRecord.id || syntheticFulfillmentId),
    order_id: Number(order.id),
    status: "success",
    created_at: firstString(sourceFulfillmentRecord.created_at, fulfilment.shippedAt),
    updated_at: firstString(sourceFulfillmentRecord.updated_at, new Date().toISOString()),
    tracking_company: trackingCompany,
    tracking_number: fulfilment.trackingNumber,
    tracking_numbers: [fulfilment.trackingNumber],
    tracking_url: trackingUrl,
    tracking_urls: trackingUrl ? [trackingUrl] : [],
    location_id: locationId,
    line_items: lineItems,
  };

  await step.sendEvent("dispatch-canonical-shopify-fulfillment", {
    id: `warehouse-fulfilment-${eventSuffix}`,
    name: "shopify/order.fulfilled",
    data: {
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      shopifyStore: config.shopify.im8.shopDomain,
      orderJson: order,
      fulfillments: [canonicalFulfillment],
      receivedAt: event.data.receivedAt || new Date().toISOString(),
      fromGpsSync: fulfilment.source === "gps",
      fromWarehouseWebhook: true,
      warehouseWebhookSource: fulfilment.source,
    },
  });

  return {
    status: "queued",
    source: fulfilment.source,
    warehouseOrderId: fulfilment.warehouseOrderId,
    shopifyOrderId: String(order.id),
    shopifyOrderName: order.name,
    warehouseName,
    trackingNumber: fulfilment.trackingNumber,
    shopifyWriteback: existingFulfillment
      ? "already_fulfilled"
      : createdFulfillment
        ? "created"
        : canWriteToShopify
          ? "no_open_fulfillment_order"
          : "disabled",
  };
}

export const processWarehouseWebhookFulfilment = inngest.createFunction(
  {
    id: "process-warehouse-webhook-fulfilment",
    name: "Process GPS/STORD Webhook Fulfilment",
    idempotency: "event.id",
    retries: 5,
    concurrency: [{ limit: 5, key: "event.data.shopifyOrderId" }],
    triggers: [{ event: "gps/fulfilment.received" }, { event: "stord/fulfilment.received" }],
  },
  async ({ event, step }) =>
    runProcessWarehouseWebhookFulfilment({
      event: event as unknown as WarehouseWebhookEvent,
      step: step as unknown as WarehouseStep,
    })
);
