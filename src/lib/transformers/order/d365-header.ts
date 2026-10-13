import type { ShopifyOrderPayload } from "../../../inngest/events";
import type { D365SalesOrderHeaderV3Request } from "../../types/dynamics";
import type { GiftCardApplication, GiftCardPurchase } from "../../helpers/payment-accounting";
import { formatAddressName, toSalesOrderHeadersV3Address } from "../address";
import {
  determineWarehouse,
  getOrderingCustomerAccountNumber,
  getOrderingCustomerAccountNumberByDataAreaId,
  getWarehouseConfig,
  getWarehouseConfigForDataAreaId,
  isGpsUkWarehouse,
  toDefaultLedgerDimensionDisplayValue,
  toDefaultLedgerDimensionDisplayValueByDataArea,
} from "../../helpers/warehouse";
import { getAssociatedOrderLink } from "../../helpers/order-linkage";

interface OrderAccounting {
  paymentReference?: string;
  giftCardApplications?: GiftCardApplication[];
  giftCardPurchases?: GiftCardPurchase[];
  shortAddress?: string;
}

export function toD365SalesOrderHeaderV3(
  order: ShopifyOrderPayload,
  warehouseName?: string,
  dataAreaIdOverride?: string,
  accounting?: OrderAccounting
): D365SalesOrderHeaderV3Request {
  const warehouse =
    warehouseName ||
    determineWarehouse(
      order.shipping_address?.country_code || order.billing_address?.country_code || "US"
    );
  const effectiveDataAreaId = (dataAreaIdOverride || "").toUpperCase();
  const warehouseConfig = effectiveDataAreaId
    ? getWarehouseConfigForDataAreaId(effectiveDataAreaId)
    : getWarehouseConfig(warehouse);
  const orderingCustomerAccountNumber = effectiveDataAreaId
    ? getOrderingCustomerAccountNumberByDataAreaId(effectiveDataAreaId)
    : getOrderingCustomerAccountNumber(warehouse);
  const defaultLedgerDimensionDisplayValue = effectiveDataAreaId
    ? toDefaultLedgerDimensionDisplayValueByDataArea(warehouse, effectiveDataAreaId)
    : toDefaultLedgerDimensionDisplayValue(warehouse);
  const shippingAddress = order.shipping_address || order.billing_address;
  const billingAddress = order.billing_address || order.shipping_address;

  return {
    customerId: String(order.customer?.id || ""),
    orderId: String(order.id),
    dataAreaId: effectiveDataAreaId || warehouseConfig.dataAreaId,
    orderingCustomerAccountNumber,
    defaultLedgerDimensionDisplayValue,
    customerOrderReference: order.name,
    email: order.email,
    name: order.customer
      ? `${order.customer.first_name} ${order.customer.last_name}`.trim()
      : formatAddressName(shippingAddress),
    shopifyReference: order.name,
    shippingAddress: shippingAddress
      ? toSalesOrderHeadersV3Address(
          shippingAddress,
          shippingAddress.country_code === "SA" ? accounting?.shortAddress : undefined
        )
      : undefined,
    billingAddress: billingAddress ? toSalesOrderHeadersV3Address(billingAddress) : undefined,
    comment: buildOrderComment(order, accounting),
    currency: order.currency,
    paymentId: accounting?.paymentReference || undefined,
    skipFulfillmentNotification: isGpsUkWarehouse(warehouse) ? "Yes" : undefined,
  };
}

function buildOrderComment(order: ShopifyOrderPayload, accounting?: OrderAccounting): string {
  const parts: string[] = [];
  const associatedOrder = getAssociatedOrderLink(order);

  if (associatedOrder) parts.push(`Associated Order: ${associatedOrder.orderName}`);

  for (const giftCard of accounting?.giftCardApplications || []) {
    parts.push(`Gift Card: ${giftCard.giftCardNumber} - ${giftCard.amount} ${giftCard.currency}`);
  }
  for (const giftCard of accounting?.giftCardPurchases || []) {
    parts.push(
      `Gift Card Purchase: ${giftCard.giftCardNumber} - ${giftCard.price} x ${giftCard.quantity}`
    );
  }

  if (order.discount_codes?.length > 0) {
    for (const discount of order.discount_codes.filter((item: any) => item.type === "gift_card")) {
      parts.push(
        `Gift Card Applied: ${discount.code} - $${parseFloat(discount.amount || "0").toFixed(2)}`
      );
    }
    const discounts = order.discount_codes.filter((item: any) => item.type !== "gift_card");
    if (discounts.length > 0) {
      parts.push(`Discount Codes: ${discounts.map((discount) => discount.code).join(", ")}`);
    }
  }

  if (order.note) parts.push(`Note: ${order.note}`);
  if (order.tags) parts.push(`Tags: ${order.tags}`);

  return parts.join("\n");
}
