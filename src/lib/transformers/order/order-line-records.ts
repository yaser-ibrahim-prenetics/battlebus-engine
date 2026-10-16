import type { ShopifyOrderPayload } from "../../../inngest/events";
import {
  createShopifyToDynamicsLineTransformer,
  explodeBundleLines,
  isDummySku,
  isServiceSku,
  mapShopifySkuToDynamicsForOrderLine,
} from "../sku";
import { getShippingSku, getTaxSku, getWarehouseConfig } from "../../helpers/warehouse";
import {
  getSubscriptionRewards,
  subscriptionRewardLineItemId,
} from "../../helpers/subscription-rewards";
import { calculateDutyAmount, calculateShippingCost, calculateTaxAmount } from "./calculations";
import { toD365SalesOrderLine } from "./d365-lines";

export interface D365OrderLineRecord {
  shopifyLineItemId: string;
  shopifySku: string | null;
  d365ItemNumber: string;
  quantity: number;
  price: number;
  isServiceLine: boolean;
}

export function toOrderLineRecords(
  order: ShopifyOrderPayload,
  salesOrderNumber: string,
  warehouseName: string,
  dataAreaIdOverride?: string
): D365OrderLineRecord[] {
  const dataAreaId =
    (dataAreaIdOverride || "").toUpperCase() || getWarehouseConfig(warehouseName).dataAreaId;
  const currency = order.currency || "USD";
  const discountCodes = order.discount_codes?.map((discount) => discount.code);
  const transformSku = createShopifyToDynamicsLineTransformer();
  const countryCode =
    order.shipping_address?.country_code || order.billing_address?.country_code || undefined;
  const records: D365OrderLineRecord[] = [];

  for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
    const rawSku = typeof item.sku === "string" ? item.sku.trim() : "";
    if (!rawSku || isDummySku(mapShopifySkuToDynamicsForOrderLine(rawSku))) continue;

    const line = transformSku(
      toD365SalesOrderLine(
        { ...item, sku: rawSku },
        salesOrderNumber,
        dataAreaId,
        currency,
        discountCodes,
        countryCode
      )
    );

    for (const component of explodeBundleLines([line])) {
      records.push({
        shopifyLineItemId: String(item.id),
        shopifySku: rawSku,
        d365ItemNumber: component.itemNumber,
        quantity: component.quantity,
        price: component.price,
        isServiceLine: isServiceSku(component.itemNumber),
      });
    }
  }

  for (const reward of getSubscriptionRewards(order)) {
    records.push({
      shopifyLineItemId: subscriptionRewardLineItemId(reward.sku),
      shopifySku: reward.sku,
      d365ItemNumber: reward.sku,
      quantity: reward.quantity,
      price: 0,
      isServiceLine: false,
    });
  }

  const shippingCost = calculateShippingCost(order);
  if (shippingCost > 0) {
    const shippingSku = getShippingSku(warehouseName, dataAreaId);
    records.push({
      shopifyLineItemId: "shipping",
      shopifySku: null,
      d365ItemNumber: shippingSku,
      quantity: 1,
      price: shippingCost,
      isServiceLine: isServiceSku(shippingSku),
    });
  }

  const taxAndDuty = calculateTaxAmount(order) + calculateDutyAmount(order);
  if (taxAndDuty > 0) {
    const taxSku = getTaxSku(warehouseName, dataAreaId);
    records.push({
      shopifyLineItemId: "tax",
      shopifySku: null,
      d365ItemNumber: taxSku,
      quantity: 1,
      price: taxAndDuty,
      isServiceLine: isServiceSku(taxSku),
    });
  }

  return records;
}
