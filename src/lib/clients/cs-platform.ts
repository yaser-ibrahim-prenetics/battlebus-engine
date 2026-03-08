// ============================================================================
// CS PLATFORM CLIENT
// ============================================================================
// Sends order events to battle-cs support platform

import { config } from "@/lib/config";
import crypto from "crypto";

interface OrderEvent {
  event: string;
  data: any;
}

function generateSignature(payload: string): string {
  if (!config.csPlatform.webhookSecret) return "";
  return crypto.createHmac("sha256", config.csPlatform.webhookSecret).update(payload).digest("hex");
}

export async function sendOrderEvent(event: OrderEvent): Promise<void> {
  if (!config.csPlatform.enabled) {
    console.log("[CS Platform] Disabled, skipping webhook");
    return;
  }

  if (!config.csPlatform.baseUrl) {
    console.warn("[CS Platform] CS_PLATFORM_URL not configured, skipping webhook");
    return;
  }

  if (config.features.dryRunMode) {
    console.log(`[CS Platform] DRY RUN - Would send event: ${event.event}`);
    return;
  }

  try {
    const payload = JSON.stringify(event);
    const signature = generateSignature(payload);

    // Route events to appropriate webhook endpoints
    let webhookPath = "/api/webhooks/orders"; // Default
    if (event.event.startsWith("product.")) {
      webhookPath = "/api/webhooks/products";
    } else if (event.event.startsWith("location.")) {
      webhookPath = "/api/webhooks/locations";
    }

    const response = await fetch(`${config.csPlatform.baseUrl}${webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Battle-Bus-Signature": signature,
      },
      body: payload,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[CS Platform] Failed to send event ${event.event}: ${error}`);
      throw new Error(`CS Platform webhook failed: ${error}`);
    }

    console.log(`[CS Platform] ✅ Sent event: ${event.event}`);
  } catch (error) {
    console.error(`[CS Platform] Error sending event ${event.event}:`, error);
    // Don't throw - webhook failures shouldn't break order processing
  }
}

export async function sendOrderCreated(
  orderData: any,
  inngestIds?: { inngestIdempotencyKey?: string; inngestRunId?: string }
): Promise<void> {
  // Extract sync statuses - these are derived from what processing has completed
  const syncStatuses: Record<string, string> = {};

  // If we have D365 order number, Shopify import and D365 sync succeeded
  if (orderData.d365OrderNumber) {
    syncStatuses.shopifySyncStatus = "synced";
    syncStatuses.d365SyncStatus = "synced";
  }

  // If we have GPS order ID, GPS sync succeeded
  if (orderData.gpsOrderId) {
    syncStatuses.gpsSyncStatus = "synced";
  } else if (orderData.warehouse) {
    // We have warehouse assignment but no GPS order yet - might be pending or skipped
    syncStatuses.gpsSyncStatus = orderData.gpsSkipped ? "skipped" : "pending";
  }

  await sendOrderEvent({
    event: "order.created",
    data: {
      orderId: orderData.id || orderData.shopifyOrderId,
      shopifyOrderName: orderData.name || orderData.shopifyOrderName,
      shopifyOrderId: orderData.id || orderData.shopifyOrderId,
      ...orderData,
      ...syncStatuses,
      // Include Inngest IDs for linking to dashboard:
      // - inngestIdempotencyKey: the event-level idempotency key (e.g., "shopify-order-paid-xxx")
      // - inngestRunId: the run ID for /runs/ URLs (e.g., "01KGWWR0AKZMSTNYJ6VWJMR7DD")
      inngestIdempotencyKey: inngestIds?.inngestIdempotencyKey,
      inngestRunId: inngestIds?.inngestRunId,
      // Keep inngestEventId for backwards compatibility (same as idempotency key)
      inngestEventId: inngestIds?.inngestIdempotencyKey,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderUpdated(
  orderData: any,
  changes?: string[],
  inngestIds?: { inngestIdempotencyKey?: string; inngestRunId?: string }
): Promise<void> {
  await sendOrderEvent({
    event: "order.updated",
    data: {
      orderId: orderData.id || orderData.shopifyOrderId,
      shopifyOrderName: orderData.name || orderData.shopifyOrderName,
      shopifyOrderId: orderData.id || orderData.shopifyOrderId,
      ...orderData,
      changedFields: changes,
      inngestIdempotencyKey: inngestIds?.inngestIdempotencyKey,
      inngestRunId: inngestIds?.inngestRunId,
      inngestEventId: inngestIds?.inngestIdempotencyKey,
      updatedAt: new Date().toISOString(),
    },
  });
}

// Send order status update (for intermediate states like out_of_stock, waiting, etc.)
export async function sendOrderUpdate(
  orderData: {
    id?: string;
    name?: string;
    shopifyOrderId?: string;
    shopifyOrderName?: string;
    d365OrderNumber?: string;
    warehouse?: string;
    status?: string;
    error?: string;
    errorType?: string;
    retryAt?: string;
    [key: string]: any;
  },
  inngestIds?: { inngestIdempotencyKey?: string; inngestRunId?: string }
): Promise<void> {
  await sendOrderEvent({
    event: "order.status_update",
    data: {
      orderId: orderData.id || orderData.shopifyOrderId,
      shopifyOrderName: orderData.name || orderData.shopifyOrderName,
      shopifyOrderId: orderData.id || orderData.shopifyOrderId,
      ...orderData,
      inngestIdempotencyKey: inngestIds?.inngestIdempotencyKey,
      inngestRunId: inngestIds?.inngestRunId,
      inngestEventId: inngestIds?.inngestIdempotencyKey,
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderFulfilled(orderData: {
  orderId?: string;
  shopifyOrderName: string;
  trackingNumber: string;
  carrier: string;
  fulfillmentId?: string;
  shopifyFulfillmentStatus?: string;
  shopifyFinancialStatus?: string;
}): Promise<void> {
  await sendOrderEvent({
    event: "order.fulfilled",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      trackingNumber: orderData.trackingNumber,
      carrier: orderData.carrier,
      fulfillmentId: orderData.fulfillmentId,
      shopifyFulfillmentStatus: orderData.shopifyFulfillmentStatus || "fulfilled",
      shopifyFinancialStatus: orderData.shopifyFinancialStatus,
      fulfilledAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderCancelled(orderData: {
  orderId?: string;
  shopifyOrderName: string;
  reason?: string;
  shopifyFinancialStatus?: string;
  shopifyCancelledAt?: string;
}): Promise<void> {
  await sendOrderEvent({
    event: "order.cancelled",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      reason: orderData.reason,
      shopifyFinancialStatus: orderData.shopifyFinancialStatus,
      shopifyCancelledAt: orderData.shopifyCancelledAt,
      cancelledAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderRefunded(orderData: {
  orderId?: string;
  shopifyOrderName: string;
  amount?: string;
  reason?: string;
  shopifyFinancialStatus?: string;
  refundType?: "full" | "partial";
}): Promise<void> {
  // Determine financial status based on refund type
  const financialStatus =
    orderData.shopifyFinancialStatus ||
    (orderData.refundType === "partial" ? "partially_refunded" : "refunded");

  await sendOrderEvent({
    event: "order.refunded",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      amount: orderData.amount,
      reason: orderData.reason,
      shopifyFinancialStatus: financialStatus,
      refundType: orderData.refundType,
      refundedAt: new Date().toISOString(),
    },
  });
}

// ============================================================================
// PRODUCT EVENT FUNCTIONS
// ============================================================================

export async function sendProductCreated(productData: {
  productId: string;
  productTitle: string;
  shopifyStore?: string;
  variants?: Array<{
    sku?: string;
    price?: string;
    barcode?: string;
    weight?: number;
    weight_unit?: string;
    inventory_quantity?: number;
    inventory_item_id?: number;
    variant_id?: number;
    title?: string;
    inventory_levels?: Array<{
      location_id: string;
      location_name: string | null;
      available: number;
      reserved: number;
      committed: number;
    }>;
  }>;
  vendor?: string;
  productType?: string;
  tags?: string;
  status?: string;
  d365Result?: any;
  gpsResult?: any;
}): Promise<void> {
  await sendOrderEvent({
    event: "product.created",
    data: {
      productId: productData.productId,
      productTitle: productData.productTitle,
      shopifyStore: productData.shopifyStore,
      variants: productData.variants || [],
      vendor: productData.vendor,
      productType: productData.productType,
      tags: productData.tags,
      status: productData.status,
      d365Result: productData.d365Result,
      gpsResult: productData.gpsResult,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function sendProductUpdated(productData: {
  productId: string;
  productTitle: string;
  shopifyStore?: string;
  variants?: Array<{
    sku?: string;
    price?: string;
    barcode?: string;
    weight?: number;
    weight_unit?: string;
    inventory_quantity?: number;
    inventory_item_id?: number;
    variant_id?: number;
    title?: string;
    inventory_levels?: Array<{
      location_id: string;
      location_name: string | null;
      available: number;
      reserved: number;
      committed: number;
    }>;
  }>;
  vendor?: string;
  productType?: string;
  tags?: string;
  status?: string;
  d365Result?: any;
  gpsResult?: any;
}): Promise<void> {
  await sendOrderEvent({
    event: "product.updated",
    data: {
      productId: productData.productId,
      productTitle: productData.productTitle,
      shopifyStore: productData.shopifyStore,
      variants: productData.variants || [],
      vendor: productData.vendor,
      productType: productData.productType,
      tags: productData.tags,
      status: productData.status,
      d365Result: productData.d365Result,
      gpsResult: productData.gpsResult,
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function sendProductDeleted(productData: {
  productId: string;
  productTitle?: string;
  shopifyStore?: string;
  d365Result?: any;
  gpsResult?: any;
}): Promise<void> {
  await sendOrderEvent({
    event: "product.deleted",
    data: {
      productId: productData.productId,
      productTitle: productData.productTitle,
      shopifyStore: productData.shopifyStore,
      d365Result: productData.d365Result,
      gpsResult: productData.gpsResult,
      deletedAt: new Date().toISOString(),
    },
  });
}

export async function sendLocationEvent(eventData: {
  event: "location.created" | "location.updated" | "location.deleted";
  data: {
    id: string;
    name: string;
    shopify_location_id: string;
    warehouse_name?: string;
    dynamics_data_area_id?: string;
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
    phone?: string | null;
    active?: boolean;
    fulfillment_service_id?: string | null;
  };
}): Promise<void> {
  await sendOrderEvent({
    event: eventData.event,
    data: {
      ...eventData.data,
      createdAt: eventData.event === "location.created" ? new Date().toISOString() : undefined,
      updatedAt: eventData.event === "location.updated" ? new Date().toISOString() : undefined,
      deletedAt: eventData.event === "location.deleted" ? new Date().toISOString() : undefined,
    },
  });
}
