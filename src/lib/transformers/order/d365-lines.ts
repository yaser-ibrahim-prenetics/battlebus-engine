import type { ShopifyLineItem, ShopifyOrderPayload } from "../../../inngest/events";
import type { D365SalesOrderLineRequest } from "../../types/dynamics";
import {
  createShopifyToDynamicsLineTransformer,
  explodeBundleLines,
  isDummySku,
  isServiceSku,
  mapShopifySkuToDynamicsForOrderLine,
} from "../sku";
import {
  getShippingSku,
  getTaxSku,
  getWarehouseConfig,
  getWarehouseConfigForDataAreaId,
} from "../../helpers/warehouse";
import { getSubscriptionRewards } from "../../helpers/subscription-rewards";
import {
  calculateDutyAmount,
  calculateShippingListAndDiscount,
  calculateTaxAmount,
} from "./calculations";

export function toD365SalesOrderLine(
  lineItem: ShopifyLineItem,
  salesOrderNumber: string,
  dataAreaId: string,
  currency: string,
  discountCodes?: string[],
  countryCode?: string
): D365SalesOrderLineRequest {
  const itemNumber = typeof lineItem.sku === "string" ? lineItem.sku.trim() : "";
  const price = parseFloat(lineItem.price);
  const totalDiscount = parseFloat(lineItem.total_discount) || 0;
  const discountPerUnit = lineItem.quantity > 0 ? totalDiscount / lineItem.quantity : 0;

  return {
    salesOrderNumber,
    dataAreaId,
    itemNumber,
    quantity: lineItem.quantity,
    price,
    ...(discountPerUnit > 0 ? { discount: discountPerUnit } : {}),
    currency,
    discountCode: discountCodes,
    ...(countryCode ? { countryCode } : {}),
  };
}

export function toD365SalesOrderLines(
  order: ShopifyOrderPayload,
  salesOrderNumber: string,
  warehouseName: string,
  includeShippingAndTax: boolean = true,
  dataAreaIdOverride?: string,
  giftCardCodes: Record<string, string> = {}
): D365SalesOrderLineRequest[] {
  const effectiveDataAreaId = (dataAreaIdOverride || "").toUpperCase();
  const dataAreaId = effectiveDataAreaId || getWarehouseConfig(warehouseName).dataAreaId;
  const warehouseConfig = effectiveDataAreaId
    ? getWarehouseConfigForDataAreaId(effectiveDataAreaId)
    : getWarehouseConfig(warehouseName);
  const shippingWarehouseId = warehouseConfig.fulfilment.shippingWarehouseId;
  const currency = order.currency || "USD";
  const discountCodes = order.discount_codes?.map((discount) => discount.code);
  const transformSku = createShopifyToDynamicsLineTransformer();
  const countryCode =
    order.shipping_address?.country_code || order.billing_address?.country_code || undefined;
  const lines: D365SalesOrderLineRequest[] = [];

  if (!Array.isArray(order.line_items)) {
    console.warn(
      "[Transformers] order.line_items is missing or not an array – skipping product lines. " +
        "This usually means a test payload is incomplete."
    );
  }

  for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
    const rawSku = typeof item.sku === "string" ? item.sku.trim() : "";
    if (!rawSku) {
      if (item.requires_shipping === false) {
        console.warn(
          `[Transformers] Skipping non-shippable line without SKU for ${order.name}: ` +
            `${item.title || "untitled"} (variant=${item.variant_id || "n/a"}, product=${item.product_id || "n/a"})`
        );
        continue;
      }
      throw new Error(
        `[D365] Missing SKU on shippable Shopify line item for ${order.name}: ` +
          `${item.title || "untitled"} (variant=${item.variant_id || "n/a"}, product=${item.product_id || "n/a"})`
      );
    }

    const mappedSku = mapShopifySkuToDynamicsForOrderLine(rawSku);
    if (isDummySku(mappedSku)) {
      console.warn(
        `[Transformers] Skipping dummy/test SKU for D365 ${order.name}: ${mappedSku} (no released item in D365)`
      );
      continue;
    }

    const line = toD365SalesOrderLine(
      { ...item, sku: rawSku },
      salesOrderNumber,
      dataAreaId,
      currency,
      discountCodes,
      countryCode
    );
    if (item.gift_card) line.giftCardNumber = giftCardCodes[String(item.id)];
    const transformedLine = transformSku(line);
    lines.push(
      shippingWarehouseId && !isServiceSku(transformedLine.itemNumber)
        ? { ...transformedLine, shippingWarehouseId }
        : transformedLine
    );
  }

  const productLines = explodeBundleLines(lines);
  lines.length = 0;
  lines.push(...productLines);

  for (const reward of getSubscriptionRewards(order)) {
    lines.push({
      salesOrderNumber,
      dataAreaId,
      itemNumber: reward.sku,
      quantity: reward.quantity,
      price: 0,
      currency,
      ...(shippingWarehouseId ? { shippingWarehouseId } : {}),
    });
  }

  if (includeShippingAndTax) {
    const { listTotal, discountTotal } = calculateShippingListAndDiscount(order);
    if (listTotal > 0) {
      lines.push({
        salesOrderNumber,
        dataAreaId,
        itemNumber: getShippingSku(warehouseName, dataAreaId),
        quantity: 1,
        price: listTotal,
        ...(discountTotal > 0 ? { discount: discountTotal } : {}),
        currency,
      });
    }

    const taxAndDuty = calculateTaxAmount(order) + calculateDutyAmount(order);
    if (taxAndDuty > 0) {
      lines.push({
        salesOrderNumber,
        dataAreaId,
        itemNumber: getTaxSku(warehouseName, dataAreaId),
        quantity: 1,
        price: taxAndDuty,
        currency,
      });
    }
  }

  return lines;
}
