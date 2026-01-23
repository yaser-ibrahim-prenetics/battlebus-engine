// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
// Common validation functions for order processing

import type { ShopifyOrderPayload, ShopifyFulfillment } from "../../events";

/**
 * Check if fulfillment is a dummy/refund fulfillment
 * Filters out adjustment SKUs and negative fulfillments
 */
export function isDummyFulfillment(fulfillment: ShopifyFulfillment): boolean {
  const hasRealItems = fulfillment.line_items.some((item) => {
    const sku = item.sku || "";
    return (
      sku.length > 0 &&
      !sku.startsWith("ADJUSTMENT") &&
      !sku.startsWith("SHIPPING") &&
      !item.price.startsWith("-")
    );
  });

  return !hasRealItems;
}

/**
 * Validate that order has required fields for processing
 */
export function validateOrderPayload(order: ShopifyOrderPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!order.id) {
    errors.push("Order ID is required");
  }

  if (!order.name) {
    errors.push("Order name is required");
  }

  if (!order.email) {
    errors.push("Order email is required");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if order can be cancelled
 */
export function canCancelOrder(order: ShopifyOrderPayload): {
  canCancel: boolean;
  reason?: string;
} {
  if (order.fulfillment_status === "fulfilled") {
    return {
      canCancel: false,
      reason: "Order is already fulfilled",
    };
  }

  if (order.cancelled_at) {
    return {
      canCancel: false,
      reason: "Order is already cancelled",
    };
  }

  return { canCancel: true };
}

