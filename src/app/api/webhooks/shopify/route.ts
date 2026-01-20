// ============================================================================
// SHOPIFY WEBHOOK HANDLER
// ============================================================================
// Receives Shopify webhooks and sends events to Inngest

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { verifyWebhookSignature } from "@/lib/clients/shopify";

export async function POST(request: NextRequest) {
  try {
    // Get the raw body for signature verification
    const body = await request.text();
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
    const topic = request.headers.get("x-shopify-topic");
    const shopDomain = request.headers.get("x-shopify-shop-domain");

    // Verify webhook signature
    if (hmacHeader && !verifyWebhookSignature(body, hmacHeader)) {
      console.error("[Webhook] Invalid Shopify signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Parse the webhook body
    const payload = JSON.parse(body);

    console.log(`[Webhook] Received Shopify ${topic} from ${shopDomain}`);

    // Route to appropriate event based on topic
    // IMPORTANT: Each event includes an `id` for event-level idempotency
    // This prevents duplicate events from being stored (24-hour window)
    switch (topic) {
      // Order creation - main flow
      case "orders/create":
        await inngest.send({
          id: `shopify-order-created-${payload.id}`, // Event-level idempotency key
          name: "shopify/order.created",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: shopDomain || "im8",
            orderJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        console.log(`[Webhook] Sent shopify/order.created for ${payload.name}`);
        break;

      // Order paid - triggers order processing (alternative to orders/create)
      case "orders/paid":
        await inngest.send({
          id: `shopify-order-paid-${payload.id}`, // Event-level idempotency key
          name: "shopify/order.paid",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: shopDomain || "im8",
            orderJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        console.log(`[Webhook] Sent shopify/order.paid for ${payload.name}`);
        break;

      // Order updated - may need to sync changes to D365
      case "orders/updated":
        // Only process if order is paid (avoid processing draft updates)
        if (payload.financial_status === "paid") {
          await inngest.send({
            // Use updated_at to allow re-processing when order actually changes
            id: `shopify-order-updated-${payload.id}-${payload.updated_at}`,
            name: "shopify/order.updated", // Now routes to debounced handler
            data: {
              shopifyOrderId: String(payload.id),
              shopifyOrderName: payload.name,
              shopifyStore: shopDomain || "im8",
              orderJson: payload,
              receivedAt: new Date().toISOString(),
            },
          });
          console.log(`[Webhook] Sent shopify/order.updated for ${payload.name}`);
        } else {
          console.log(`[Webhook] Skipped orders/updated for ${payload.name} - status: ${payload.financial_status}`);
        }
        break;

      // Order cancelled - need to cancel in D365 and GPS
      case "orders/cancelled":
        await inngest.send({
          id: `shopify-order-cancelled-${payload.id}`, // Event-level idempotency key
          name: "shopify/order.cancelled",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: shopDomain || "im8",
            orderJson: payload,
            cancelledAt: payload.cancelled_at || new Date().toISOString(),
            cancelReason: payload.cancel_reason || null,
            receivedAt: new Date().toISOString(),
          },
        });
        console.log(`[Webhook] Sent shopify/order.cancelled for ${payload.name}`);
        break;

      // Order fulfilled - Shopify notifying us (we usually initiate this)
      case "orders/fulfilled":
        console.log(`[Webhook] Received orders/fulfilled for ${payload.name} - no action needed (we initiate fulfillments)`);
        break;

      // Refund created - need to create credit note in D365
      case "refunds/create":
        await inngest.send({
          id: `shopify-refund-created-${payload.id}`, // Event-level idempotency key
          name: "shopify/refund.created",
          data: {
            shopifyOrderId: String(payload.order_id),
            refundId: String(payload.id),
            shopifyStore: shopDomain || "im8",
            refundJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        console.log(`[Webhook] Sent shopify/refund.created for order ${payload.order_id}`);
        break;

      default:
        console.log(`[Webhook] Unhandled Shopify topic: ${topic}`);
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("[Webhook] Error processing Shopify webhook:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Shopify sends a GET request to verify the webhook endpoint
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
