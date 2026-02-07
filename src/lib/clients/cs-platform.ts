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
  return crypto
    .createHmac("sha256", config.csPlatform.webhookSecret)
    .update(payload)
    .digest("hex");
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

    const response = await fetch(`${config.csPlatform.baseUrl}/api/webhooks/orders`, {
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

export async function sendOrderCreated(orderData: any, inngestEventId?: string): Promise<void> {
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
      inngestEventId, // Include Inngest event ID for linking to dashboard
      createdAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderUpdated(orderData: any, changes?: string[], inngestEventId?: string): Promise<void> {
  await sendOrderEvent({
    event: "order.updated",
    data: {
      orderId: orderData.id || orderData.shopifyOrderId,
      shopifyOrderName: orderData.name || orderData.shopifyOrderName,
      shopifyOrderId: orderData.id || orderData.shopifyOrderId,
      ...orderData,
      changedFields: changes,
      inngestEventId, // Include Inngest event ID for linking to dashboard
      updatedAt: new Date().toISOString(),
    },
  });
}

// Send order status update (for intermediate states like out_of_stock, waiting, etc.)
export async function sendOrderUpdate(orderData: {
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
}, inngestEventId?: string): Promise<void> {
  await sendOrderEvent({
    event: "order.status_update",
    data: {
      orderId: orderData.id || orderData.shopifyOrderId,
      shopifyOrderName: orderData.name || orderData.shopifyOrderName,
      shopifyOrderId: orderData.id || orderData.shopifyOrderId,
      ...orderData,
      inngestEventId,
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
}): Promise<void> {
  await sendOrderEvent({
    event: "order.fulfilled",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      trackingNumber: orderData.trackingNumber,
      carrier: orderData.carrier,
      fulfillmentId: orderData.fulfillmentId,
      fulfilledAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderCancelled(orderData: {
  orderId?: string;
  shopifyOrderName: string;
  reason?: string;
}): Promise<void> {
  await sendOrderEvent({
    event: "order.cancelled",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      reason: orderData.reason,
      cancelledAt: new Date().toISOString(),
    },
  });
}

export async function sendOrderRefunded(orderData: {
  orderId?: string;
  shopifyOrderName: string;
  amount?: string;
  reason?: string;
}): Promise<void> {
  await sendOrderEvent({
    event: "order.refunded",
    data: {
      orderId: orderData.orderId,
      shopifyOrderName: orderData.shopifyOrderName,
      amount: orderData.amount,
      reason: orderData.reason,
      refundedAt: new Date().toISOString(),
    },
  });
}

