// ============================================================================
// SHOPIFY WEBHOOK HANDLER
// ============================================================================
// Receives Shopify webhooks and sends events to Inngest

import { NextRequest, NextResponse } from "next/server";
import {
  verifyWebhookSignature,
  resolveShopifyWebhookSecret,
  shopifyWebhookSecretSource,
} from "@/lib/clients/shopify";
import { config } from "@/lib/config";
import { shopifyOrderWebhookSchema, validateWebhookSchema } from "@/lib/schemas/webhook-schemas";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";
import { shouldSuppressShopifyRefundWebhookForLoopReturns } from "@/lib/services/shopify-loop-refund-detection";
import { publishWebhookEvents } from "@/lib/webhooks/publish-with-inbox";
import type { WebhookInboxEvent } from "@/lib/services/supabase-webhook-inbox";

function validateWebhookPayload(topic: string | null, payload: any): string | null {
  if (!topic) return "Missing x-shopify-topic header";
  if (!payload || typeof payload !== "object") return "Invalid JSON payload";

  const hasStringOrNumber = (v: unknown) =>
    typeof v === "string" ? v.trim().length > 0 : typeof v === "number";

  switch (topic) {
    case "orders/create":
    case "orders/paid":
    case "orders/updated":
    case "orders/cancelled":
      if (!hasStringOrNumber(payload.id)) return "Missing required field: id";
      if (!hasStringOrNumber(payload.name)) return "Missing required field: name";
      if (!Array.isArray(payload.line_items)) return "Missing required field: line_items[]";
      break;
    case "refunds/create":
      if (!hasStringOrNumber(payload.id)) return "Missing required field: id";
      if (!hasStringOrNumber(payload.order_id)) return "Missing required field: order_id";
      break;
    case "locations/create":
    case "locations/update":
    case "locations/delete":
      if (!hasStringOrNumber(payload.id)) return "Missing required field: id";
      if (!hasStringOrNumber(payload.name)) return "Missing required field: name";
      break;
    case "inventory_levels/update":
      if (!hasStringOrNumber(payload.inventory_item_id))
        return "Missing required field: inventory_item_id";
      if (!hasStringOrNumber(payload.location_id)) return "Missing required field: location_id";
      break;
    default:
      // unknown topics are handled by default switch branch later
      return null;
  }

  return null;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = `webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Get the raw body for signature verification
    const body = await request.text();
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
    const topic = request.headers.get("x-shopify-topic");
    const shopDomain = request.headers.get("x-shopify-shop-domain");
    const effectiveShopDomain = shopDomain || config.shopify.im8.shopDomain || "";
    const secretShopDomain = effectiveShopDomain || null;
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
    logFlowEvent({
      level: "info",
      flow: "shopify_webhook",
      step: "received",
      client: "shopify",
      requestId,
      status: "started",
      payload: {
        topic,
        shopDomain,
        webhookId,
        apiVersion,
      },
    });

    // Verify webhook signature
    const isDev = process.env.NODE_ENV !== "production";
    let signatureValid = true;

    // Secret for HMAC: matches x-shopify-shop-domain to SHOPIFY_PROD_* vs SHOPIFY_TEST_*
    const webhookSecretForShop = resolveShopifyWebhookSecret(secretShopDomain);
    if (!webhookSecretForShop) {
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
        console.log(
          `[Webhook] [${requestId}] HMAC secret bucket: ${shopifyWebhookSecretSource(secretShopDomain)} (shop=${secretShopDomain || "unknown"})`
        );
        try {
          signatureValid = verifyWebhookSignature(body, hmacHeader, secretShopDomain);
        } catch (err) {
          // crypto.timingSafeEqual throws if buffer lengths differ
          console.error(`[Webhook] [${requestId}] ❌ Error verifying Shopify signature:`, err);
          signatureValid = false;
        }

        if (!signatureValid) {
          console.error(
            `[Webhook] [${requestId}] ❌ Invalid Shopify signature (after verification)`,
            JSON.stringify({
              shopDomain,
              topic,
              bodyBytes: body.length,
              hmacHeaderPresent: Boolean(hmacHeader),
              webhookSecretConfigured: Boolean(webhookSecretForShop),
              webhookSecretSource: shopifyWebhookSecretSource(secretShopDomain),
            })
          );
          return NextResponse.json({ error: "Invalid signature", requestId }, { status: 401 });
        }
      }
    } else {
      // Secret is configured but the header is missing — reject to prevent spoofing
      console.error(`[Webhook] [${requestId}] ❌ Missing x-shopify-hmac-sha256 header`);
      return NextResponse.json({ error: "Missing signature header", requestId }, { status: 401 });
    }

    console.log(`[Webhook] [${requestId}] ✅ Signature check complete`);

    // =========================================================================
    // LOG: Raw body (before parsing)
    // =========================================================================
    console.log(`[Webhook] [${requestId}] Raw body (first 500 chars):`, body.substring(0, 500));

    // Parse the webhook body
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      console.error(`[Webhook] [${requestId}] ❌ Malformed JSON payload`);
      return NextResponse.json({ error: "Malformed JSON payload", requestId }, { status: 400 });
    }

    // Zod schema validation for order-related topics
    const orderTopics = [
      "orders/create",
      "orders/paid",
      "orders/updated",
      "orders/cancelled",
      "orders/fulfilled",
    ];
    if (topic && orderTopics.includes(topic)) {
      const zodValidation = validateWebhookSchema(shopifyOrderWebhookSchema, payload);
      if (!zodValidation.success) {
        console.error(
          `[Webhook] [${requestId}] ❌ Invalid Shopify order payload: ${zodValidation.error}`
        );
        return NextResponse.json(
          { error: `Invalid payload: ${zodValidation.error}`, requestId },
          { status: 400 }
        );
      }
    }

    const payloadError = validateWebhookPayload(topic, payload);
    if (payloadError) {
      console.error(`[Webhook] [${requestId}] ❌ Invalid webhook payload: ${payloadError}`);
      return NextResponse.json({ error: payloadError, requestId }, { status: 400 });
    }

    // =========================================================================
    // LOG: Payload details
    // =========================================================================
    console.log(`[Webhook] [${requestId}] Payload parsed successfully`);
    if (topic === "orders/create" || topic === "orders/paid" || topic === "orders/updated") {
      console.log(`[Webhook] [${requestId}] Order ID: ${payload.id}`);
      console.log(`[Webhook] [${requestId}] Order Name: ${payload.name}`);
      console.log(`[Webhook] [${requestId}] Financial Status: ${payload.financial_status}`);
      console.log(
        `[Webhook] [${requestId}] Fulfillment Status: ${payload.fulfillment_status || "null"}`
      );
      console.log(`[Webhook] [${requestId}] Total: ${payload.total_price} ${payload.currency}`);
      console.log(`[Webhook] [${requestId}] Line Items: ${payload.line_items?.length || 0}`);
      console.log(`[Webhook] [${requestId}] Customer: ${payload.email || "N/A"}`);
    } else if (topic === "refunds/create") {
      console.log(`[Webhook] [${requestId}] Refund ID: ${payload.id}`);
      console.log(`[Webhook] [${requestId}] Order ID: ${payload.order_id}`);
      const refundTx = payload.transactions?.[0];
      console.log(
        `[Webhook] [${requestId}] Refund Amount: ${refundTx?.amount || "N/A"} ${refundTx?.currency || ""}`.trim()
      );
      if (payload.order_adjustments?.length) {
        const adj = payload.order_adjustments[0]?.amount_set;
        console.log(
          `[Webhook] [${requestId}] Refund adjustments presentment: ` +
            `${adj?.presentment_money?.amount ?? "N/A"} ${adj?.presentment_money?.currency_code ?? ""}`.trim()
        );
      }
    } else if (topic === "products/create" || topic === "products/update") {
      console.log(`[Webhook] [${requestId}] Product ID: ${payload.id}`);
      console.log(`[Webhook] [${requestId}] Product Title: ${payload.title}`);
      console.log(`[Webhook] [${requestId}] Variants: ${payload.variants?.length || 0}`);
      console.log(`[Webhook] [${requestId}] Status: ${payload.status}`);
    } else if (topic === "inventory_levels/update") {
      console.log(`[Webhook] [${requestId}] Inventory Item ID: ${payload.inventory_item_id}`);
      console.log(`[Webhook] [${requestId}] Location ID: ${payload.location_id}`);
      console.log(`[Webhook] [${requestId}] Available: ${payload.available}`);
    }

    // Route to appropriate event based on topic
    // IMPORTANT: Each event includes an `id` for event-level idempotency
    // This prevents duplicate events from being stored (24-hour window)
    //
    // Events are collected here and published together (once, via the shared
    // durable-inbox helper) after the switch below, so every branch's
    // response reflects the same publish success/failure.
    const eventsToSend: WebhookInboxEvent[] = [];

    switch (topic) {
      // Order creation - main flow
      case "orders/create":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/order.created`);
        eventsToSend.push({
          id: `shopify-order-created-${payload.id}`, // Event-level idempotency key
          name: "shopify/order.created",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: effectiveShopDomain,
            orderJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Order paid - triggers order processing (alternative to orders/create)
      case "orders/paid": {
        // Detect Skio / subscription contract renewals via source_name
        const isSubscriptionRenewal = payload.source_name === "subscription_contract";
        const subscriptionContractId =
          payload.note_attributes?.find(
            (a: { name: string; value: string }) =>
              a.name === "subscription_id" || a.name === "contract_id"
          )?.value || "";

        if (isSubscriptionRenewal) {
          console.log(
            `[Webhook] [${requestId}] 🔄 Subscription renewal detected for ${payload.name} (Skio contract: ${subscriptionContractId || "unknown"})`
          );
          console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/subscription.renewed`);
          eventsToSend.push({
            id: `shopify-subscription-renewed-${payload.id}`,
            name: "shopify/subscription.renewed",
            data: {
              shopifyOrderId: String(payload.id),
              shopifyOrderName: payload.name,
              shopifyStore: effectiveShopDomain,
              subscriptionContractId,
              orderJson: payload,
              receivedAt: new Date().toISOString(),
            },
          });
        } else {
          console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/order.paid`);
          const idempotencyKey = `shopify-order-paid-${payload.id}`;
          eventsToSend.push({
            id: idempotencyKey,
            name: "shopify/order.paid",
            data: {
              shopifyOrderId: String(payload.id),
              shopifyOrderName: payload.name,
              shopifyStore: effectiveShopDomain,
              orderJson: payload,
              receivedAt: new Date().toISOString(),
              inngestIdempotencyKey: idempotencyKey,
            },
          });
        }
        break;
      }

      // Order updated - may need to sync changes to D365
      case "orders/updated":
        // Only process if order is paid (avoid processing draft updates)
        if (payload.financial_status === "paid") {
          console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/order.updated`);
          eventsToSend.push({
            // Use updated_at to allow re-processing when order actually changes
            id: `shopify-order-updated-${payload.id}-${payload.updated_at}`,
            name: "shopify/order.updated", // Now routes to debounced handler
            data: {
              shopifyOrderId: String(payload.id),
              shopifyOrderName: payload.name,
              shopifyStore: effectiveShopDomain,
              orderJson: payload,
              receivedAt: new Date().toISOString(),
            },
          });
        } else {
          console.log(
            `[Webhook] [${requestId}] ⏭️  Skipped orders/updated for ${payload.name} - status: ${payload.financial_status}`
          );
        }
        break;

      // Order cancelled - need to cancel in D365 and GPS
      case "orders/cancelled":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/order.cancelled`);
        eventsToSend.push({
          id: `shopify-order-cancelled-${payload.id}`, // Event-level idempotency key
          name: "shopify/order.cancelled",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: effectiveShopDomain,
            orderJson: payload,
            cancelledAt: payload.cancelled_at || new Date().toISOString(),
            cancelReason: payload.cancel_reason || null,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Order fulfilled - Shopify notifying us (Flow 7: Shopify Direct Fulfillment)
      // This happens when Shopify is the source of truth (manual, Stord, etc.)
      case "orders/fulfilled":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/order.fulfilled`);
        eventsToSend.push({
          id: `shopify-order-fulfilled-${payload.id}-${payload.updated_at}`, // Event-level idempotency key
          name: "shopify/order.fulfilled",
          data: {
            shopifyOrderId: String(payload.id),
            shopifyOrderName: payload.name,
            shopifyStore: effectiveShopDomain,
            orderJson: payload,
            fulfillments: payload.fulfillments || [],
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Refund created - need to create credit note in D365
      case "refunds/create": {
        const loopDuplicate = await shouldSuppressShopifyRefundWebhookForLoopReturns(
          String(payload.order_id),
          payload,
          { loopIntegrationEnabled: config.loop.enabled }
        );
        if (loopDuplicate) {
          console.log(
            `[Webhook] [${requestId}] ⏭️ Skipping shopify/refund.created — Loop Returns authored this refund (D365 handled from Loop return.closed webhook)`
          );
          logFlowEvent({
            level: "info",
            flow: "shopify_webhook",
            step: "skipped_loop_returns_duplicate_refund",
            client: "shopify",
            requestId,
            shopifyOrderId: String(payload.order_id),
            status: "skipped",
            payload: {
              refundId: String(payload.id),
              reason: "loop_returns_duplicate_shopify_webhook",
            },
          });
          break;
        }

        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/refund.created`);
        eventsToSend.push({
          id: `shopify-refund-created-${payload.id}`, // Event-level idempotency key
          name: "shopify/refund.created",
          data: {
            shopifyOrderId: String(payload.order_id),
            refundId: String(payload.id),
            shopifyStore: effectiveShopDomain,
            refundJson: payload,
            receivedAt: new Date().toISOString(),
            refundInitiator: "shopify_webhook",
          },
        });
        break;
      }

      // Product created - sync to D365 & GPS
      case "products/create":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/product.created`);
        eventsToSend.push({
          id: `shopify-product-created-${payload.id}`,
          name: "shopify/product.created",
          data: {
            productId: String(payload.id),
            productTitle: payload.title,
            shopifyStore: effectiveShopDomain,
            productJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Product updated - sync changes to D365 & GPS
      case "products/update":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/product.updated`);
        eventsToSend.push({
          id: `shopify-product-updated-${payload.id}-${payload.updated_at}`,
          name: "shopify/product.updated",
          data: {
            productId: String(payload.id),
            productTitle: payload.title,
            shopifyStore: effectiveShopDomain,
            productJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Product deleted - sync deletion to D365 & GPS
      case "products/delete":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: shopify/product.deleted`);
        eventsToSend.push({
          id: `shopify-product-deleted-${payload.id}`,
          name: "shopify/product.deleted",
          data: {
            productId: String(payload.id),
            productTitle: payload.title || "Unknown",
            shopifyStore: effectiveShopDomain,
            productJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Location created - sync to Battle Hub
      case "locations/create":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: location.created`);
        eventsToSend.push({
          id: `shopify-location-created-${payload.id}`,
          name: "shopify/location.created",
          data: {
            locationId: String(payload.id),
            locationName: payload.name,
            shopifyStore: effectiveShopDomain,
            locationJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Location updated - sync to Battle Hub
      case "locations/update":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: location.updated`);
        eventsToSend.push({
          id: `shopify-location-updated-${payload.id}-${payload.updated_at}`,
          name: "shopify/location.updated",
          data: {
            locationId: String(payload.id),
            locationName: payload.name,
            shopifyStore: effectiveShopDomain,
            locationJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Location deleted - sync to Battle Hub
      case "locations/delete":
        console.log(`[Webhook] [${requestId}] 📤 Queuing event: location.deleted`);
        eventsToSend.push({
          id: `shopify-location-deleted-${payload.id}`,
          name: "shopify/location.deleted",
          data: {
            locationId: String(payload.id),
            locationName: payload.name || "Unknown",
            shopifyStore: effectiveShopDomain,
            locationJson: payload,
            receivedAt: new Date().toISOString(),
          },
        });
        break;

      // Inventory level updated - sync stock levels to D365 & GPS via mesh
      case "inventory_levels/update":
        if (!config.features.enableInventorySync) {
          console.log(
            `[Webhook] [${requestId}] ⏭️  inventory_levels/update ignored (ENABLE_INVENTORY_SYNC=false)`
          );
        } else {
          console.log(`[Webhook] [${requestId}] 📤 Queuing events: inventory/sync (via mesh)`);
          // Use the mesh API pattern - send to mesh which routes to destinations
          eventsToSend.push({
            id: `inventory-sync-shopify-${payload.inventory_item_id}-${payload.location_id}-${payload.updated_at}`,
            name: "inventory/sync",
            data: {
              source: "shopify",
              destination: "dynamics",
              payload: {
                inventoryItemId: String(payload.inventory_item_id),
                locationId: String(payload.location_id),
                available: payload.available,
                quantity: payload.available,
                action: "update",
                source: "shopify",
                timestamp: payload.updated_at || new Date().toISOString(),
              },
            },
          });
          // Also sync to GPS warehouse
          eventsToSend.push({
            id: `inventory-sync-shopify-gps-${payload.inventory_item_id}-${payload.location_id}-${payload.updated_at}`,
            name: "inventory/sync",
            data: {
              source: "shopify",
              destination: "gps",
              payload: {
                inventoryItemId: String(payload.inventory_item_id),
                locationId: String(payload.location_id),
                available: payload.available,
                quantity: payload.available,
                action: "update",
                source: "shopify",
                timestamp: payload.updated_at || new Date().toISOString(),
              },
            },
          });
        }
        break;

      default:
        console.log(`[Webhook] [${requestId}] ⚠️  Unhandled Shopify topic: ${topic}`);
    }

    // Durably record the webhook + attempt to publish the collected event(s)
    // to Inngest in one shot. On failure, respond with a 5xx so Shopify's own
    // webhook retry logic (non-2xx retried for up to 48h) kicks in — the
    // `drain-webhook-inbox` cron is the backstop for anything that still
    // never makes it through.
    const publishResult = await publishWebhookEvents({
      source: "shopify",
      topic,
      payload,
      headers: Object.fromEntries(request.headers.entries()),
      events: eventsToSend,
    });

    if (!publishResult.published) {
      console.error(
        `[Webhook] [${requestId}] ⚠️  Failed to publish ${eventsToSend.length} event(s) to Inngest:`,
        publishResult.error
      );
      logFlowEvent({
        level: "error",
        flow: "shopify_webhook",
        step: "dispatch_inngest",
        client: "inngest",
        requestId,
        status: "failed",
        errorType: "inngest_send_failed",
        errorMessage: publishResult.error,
        payload: { topic, eventCount: eventsToSend.length },
      });
      return NextResponse.json(
        { received: false, error: "inngest_publication_failed", requestId },
        { status: 502 }
      );
    }

    if (eventsToSend.length > 0) {
      console.log(
        `[Webhook] [${requestId}] ✅ Published ${eventsToSend.length} event(s) to Inngest for topic ${topic}`
      );
    }

    const duration = Date.now() - startTime;
    logFlowEvent({
      level: "info",
      flow: "shopify_webhook",
      step: "completed",
      client: "shopify",
      requestId,
      status: "completed",
      durationMs: duration,
      payload: { topic, shopDomain },
    });
    console.log(`[Webhook] [${requestId}] ✅ Completed in ${duration}ms`);
    console.log(`[Webhook] [${requestId}] ========================================`);

    return NextResponse.json({ received: true, requestId }, { status: 200 });
  } catch (error) {
    const duration = Date.now() - startTime;
    logFlowEvent({
      level: "error",
      flow: "shopify_webhook",
      step: "failed",
      client: "shopify",
      requestId,
      status: "failed",
      durationMs: duration,
      errorType: "webhook_handler_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `[Webhook] [${requestId}] ❌ Error processing Shopify webhook (${duration}ms):`,
      error
    );
    console.error(
      `[Webhook] [${requestId}] Error stack:`,
      error instanceof Error ? error.stack : "No stack trace"
    );
    console.log(`[Webhook] [${requestId}] ========================================`);

    return NextResponse.json({ error: "Internal server error", requestId }, { status: 500 });
  }
}

// Shopify sends a GET request to verify the webhook endpoint
export async function GET() {
  console.log(`[Webhook] GET request received - Shopify webhook verification`);
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
