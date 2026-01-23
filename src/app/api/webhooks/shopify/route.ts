// ============================================================================
// SHOPIFY WEBHOOK HANDLER
// ============================================================================
// Receives Shopify webhooks and sends events to Inngest

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { verifyWebhookSignature } from "@/lib/clients/shopify";
import { config } from "@/lib/config";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = `webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Get the raw body for signature verification
    const body = await request.text();
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
    const topic = request.headers.get("x-shopify-topic");
    const shopDomain = request.headers.get("x-shopify-shop-domain");
    const webhookId = request.headers.get("x-shopify-webhook-id");
    const apiVersion = request.headers.get("x-shopify-api-version");

    // =========================================================================
    // LOG: Webhook received
    // =========================================================================
    console.log(`[Webhook] [${requestId}] ========================================`);
    console.log(`[Webhook] [${requestId}] Received Shopify webhook`);
    console.log(`[Webhook] [${requestId}] Topic: ${topic}`);
    console.log(`[Webhook] [${requestId}] Shop: ${shopDomain}`);
    console.log(`[Webhook] [${requestId}] Webhook ID: ${webhookId}`);
    console.log(`[Webhook] [${requestId}] API Version: ${apiVersion}`);
    console.log(`[Webhook] [${requestId}] Body size: ${body.length} bytes`);
    console.log(`[Webhook] [${requestId}] Headers:`, {
      hmac: hmacHeader ? "present" : "missing",
      topic,
      shopDomain,
      webhookId,
      apiVersion,
    });

    // Verify webhook signature
    const isDev = process.env.NODE_ENV !== "production";
    let signatureValid = true;

    // Check if webhook secret is configured
    if (!config.shopify.im8.webhookSecret) {
      console.log(
        `[Webhook] [${requestId}] ⚠️  Webhook secret not configured - skipping signature verification`
      );
    } else if (hmacHeader) {
      // In development, allow a special "test" value to bypass real HMAC validation
      if (isDev && hmacHeader === "test") {
        console.log(
          `[Webhook] [${requestId}] ⚠️  Skipping HMAC verification in development (hmac='test')`
        );
      } else {
        try {
          signatureValid = verifyWebhookSignature(body, hmacHeader);
        } catch (err) {
          // crypto.timingSafeEqual throws if buffer lengths differ
          console.error(
            `[Webhook] [${requestId}] ❌ Error verifying Shopify signature:`,
            err
          );
          signatureValid = false;
        }

        if (!signatureValid) {
          console.error(
            `[Webhook] [${requestId}] ❌ Invalid Shopify signature (after verification)`
          );
          return NextResponse.json(
            { error: "Invalid signature", requestId },
            { status: 401 }
          );
        }
      }
    } else {
      console.log(
        `[Webhook] [${requestId}] ⚠️  No HMAC header present (x-shopify-hmac-sha256)`
      );
    }

    console.log(`[Webhook] [${requestId}] ✅ Signature check complete`);

    // =========================================================================
    // LOG: Raw body (before parsing)
    // =========================================================================
    console.log(`[Webhook] [${requestId}] Raw body (first 500 chars):`, body.substring(0, 500));

    // Parse the webhook body
    const payload = JSON.parse(body);

    // =========================================================================
    // LOG: Payload details
    // =========================================================================
    console.log(`[Webhook] [${requestId}] Payload parsed successfully`);
    if (topic === "orders/create" || topic === "orders/paid" || topic === "orders/updated") {
      console.log(`[Webhook] [${requestId}] Order ID: ${payload.id}`);
      console.log(`[Webhook] [${requestId}] Order Name: ${payload.name}`);
      console.log(`[Webhook] [${requestId}] Financial Status: ${payload.financial_status}`);
      console.log(`[Webhook] [${requestId}] Fulfillment Status: ${payload.fulfillment_status || "null"}`);
      console.log(`[Webhook] [${requestId}] Total: ${payload.total_price} ${payload.currency}`);
      console.log(`[Webhook] [${requestId}] Line Items: ${payload.line_items?.length || 0}`);
      console.log(`[Webhook] [${requestId}] Customer: ${payload.email || "N/A"}`);
    } else if (topic === "refunds/create") {
      console.log(`[Webhook] [${requestId}] Refund ID: ${payload.id}`);
      console.log(`[Webhook] [${requestId}] Order ID: ${payload.order_id}`);
      console.log(`[Webhook] [${requestId}] Refund Amount: ${payload.transactions?.[0]?.amount || "N/A"}`);
    }

    // =========================================================================
    // LOG: Full JSON payload to file
    // =========================================================================
    try {
      const logsDir = join(process.cwd(), "logs", "webhooks");
      await mkdir(logsDir, { recursive: true });
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      // Sanitize topic for filename (e.g. \"orders/paid\" -> \"orders_paid\")
      const safeTopic = (topic || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
      const filename = `${safeTopic}-${payload.id || payload.order_id || "unknown"}-${timestamp}.json`;
      const filepath = join(logsDir, filename);
      
      const logData = {
        requestId,
        timestamp: new Date().toISOString(),
        topic,
        shopDomain,
        webhookId,
        apiVersion,
        headers: {
          hmac: hmacHeader ? "present" : "missing",
          topic,
          shopDomain,
          webhookId,
          apiVersion,
        },
        payload,
      };
      
      await writeFile(filepath, JSON.stringify(logData, null, 2), "utf-8");
      console.log(`[Webhook] [${requestId}] 💾 Saved to: ${filepath}`);
    } catch (fileError) {
      console.error(`[Webhook] [${requestId}] ❌ Failed to save log file:`, fileError);
    }

    // Route to appropriate event based on topic
    // IMPORTANT: Each event includes an `id` for event-level idempotency
    // This prevents duplicate events from being stored (24-hour window)
    switch (topic) {
      // Order creation - main flow
      case "orders/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.created`);
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
        console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.created for ${payload.name}`);
        break;

      // Order paid - triggers order processing (alternative to orders/create)
      case "orders/paid":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.paid`);
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
        console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.paid for ${payload.name}`);
        break;

      // Order updated - may need to sync changes to D365
      case "orders/updated":
        // Only process if order is paid (avoid processing draft updates)
        if (payload.financial_status === "paid") {
          console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.updated`);
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
          console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.updated for ${payload.name}`);
        } else {
          console.log(`[Webhook] [${requestId}] ⏭️  Skipped orders/updated for ${payload.name} - status: ${payload.financial_status}`);
        }
        break;

      // Order cancelled - need to cancel in D365 and GPS
      case "orders/cancelled":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.cancelled`);
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
        console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.cancelled for ${payload.name}`);
        break;

      // Order fulfilled - Shopify notifying us (Flow 7: Shopify Direct Fulfillment)
      // This happens when Shopify is the source of truth (manual, Stord, etc.)
      case "orders/fulfilled":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.fulfilled`);
        await inngest.send({
          id: `shopify-order-fulfilled-${payload.id}-${payload.updated_at}`, // Event-level idempotency key
          name: "shopify/order.fulfilled",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: shopDomain || "im8",
            orderJson: payload,
            fulfillments: payload.fulfillments || [],
            receivedAt: new Date().toISOString(),
          },
        });
        console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.fulfilled for ${payload.name}`);
        break;

      // Refund created - need to create credit note in D365
      case "refunds/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/refund.created`);
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
        console.log(`[Webhook] [${requestId}] ✅ Sent shopify/refund.created for order ${payload.order_id}`);
        break;

      default:
        console.log(`[Webhook] [${requestId}] ⚠️  Unhandled Shopify topic: ${topic}`);
    }

    const duration = Date.now() - startTime;
    console.log(`[Webhook] [${requestId}] ✅ Completed in ${duration}ms`);
    console.log(`[Webhook] [${requestId}] ========================================`);

    return NextResponse.json({ received: true, requestId }, { status: 200 });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Webhook] [${requestId}] ❌ Error processing Shopify webhook (${duration}ms):`, error);
    console.error(`[Webhook] [${requestId}] Error stack:`, error instanceof Error ? error.stack : "No stack trace");
    console.log(`[Webhook] [${requestId}] ========================================`);
    
    return NextResponse.json(
      { error: "Internal server error", requestId },
      { status: 500 }
    );
  }
}

// Shopify sends a GET request to verify the webhook endpoint
export async function GET() {
  console.log(`[Webhook] GET request received - Shopify webhook verification`);
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
