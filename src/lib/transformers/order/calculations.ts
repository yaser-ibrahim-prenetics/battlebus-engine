import type { ShopifyOrderPayload } from "../../../inngest/events";

export function calculateShippingListAndDiscount(order: ShopifyOrderPayload): {
  listTotal: number;
  discountTotal: number;
} {
  if (!order.shipping_lines?.length) return { listTotal: 0, discountTotal: 0 };
  const listTotal = order.shipping_lines.reduce((t, line) => t + (parseFloat(line.price) || 0), 0);
  const afterDiscount = order.shipping_lines.reduce((t, line) => {
    const discountedPrice =
      line.discounted_price != null && line.discounted_price !== ""
        ? parseFloat(line.discounted_price) || 0
        : parseFloat(line.price) || 0;
    return t + discountedPrice;
  }, 0);

  return { listTotal, discountTotal: listTotal - afterDiscount };
}

export function calculateShippingCost(order: ShopifyOrderPayload): number {
  return calculateShippingListAndDiscount(order).listTotal;
}

export function calculateTaxAmount(order: ShopifyOrderPayload): number {
  const lines = order.tax_lines;
  if (Array.isArray(lines) && lines.length > 0) {
    return lines.reduce((total, line) => total + (parseFloat(line.price) || 0), 0);
  }
  return parseFloat(order.total_tax) || 0;
}

export function calculateDutyAmount(order: ShopifyOrderPayload): number {
  const raw = (order as any)?.current_total_duties_set?.shop_money?.amount;
  if (raw == null) return 0;
  return parseFloat(String(raw)) || 0;
}

export function calculatePrepaymentAmount(order: ShopifyOrderPayload): number {
  return parseFloat(order.total_price) || 0;
}

export function calculateOrderCost(
  lines: Array<{ price: number; discount?: number; quantity: number }>
): number {
  return lines.reduce(
    (total, line) => total + (line.price - (line.discount || 0)) * line.quantity,
    0
  );
}
