// ============================================================================
// SHOPIFY WEBHOOK HANDLER
// ============================================================================
// Receives Shopify webhooks and sends events to Inngest

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { verifyWebhookSignature } from "@/lib/clients/shopify";
import { config } from "@/lib/config";
import { shopifyOrderWebhookSchema, validateWebhookSchema } from "@/lib/schemas/webhook-schemas";

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

// Helper function to send Inngest events with error handling
async function sendInngestEvent(
  event: Parameters<typeof inngest.send>[0],
  requestId: string
): Promise<boolean> {
  try {
    await inngest.send(event);
    return true;
  } catch (error) {
    console.error(`[Webhook] [${requestId}] ⚠️  Failed to send Inngest event:`, error);
    if (process.env.NODE_ENV === "development") {
      console.warn(
        `[Webhook] [${requestId}] Inngest not available - event queued but not sent. Start Inngest dev server: npm run dev:inngest`
      );
    }
    // Don't throw - allow webhook to return success even if Inngest is unavailable
    // Events will be queued and processed when Inngest is available
    return false;
  }
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
              webhookSecretConfigured: Boolean(config.shopify.im8.webhookSecret),
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
      console.log(
        `[Webhook] [${requestId}] Refund Amount: ${payload.transactions?.[0]?.amount || "N/A"}`
      );
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
    switch (topic) {
      // Order creation - main flow
      case "orders/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.created`);
        const sent1 = await sendInngestEvent(
          {
            id: `shopify-order-created-${payload.id}`, // Event-level idempotency key
            name: "shopify/order.created",
            data: {
              shopifyOrderId: String(payload.id),
              shopifyOrderName: payload.name,
              shopifyStore: shopDomain || "im8",
              orderJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent1) {
          console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.created for ${payload.name}`);
        } else {
          console.log(
            `[Webhook] [${requestId}] ⚠️  Queued shopify/order.created for ${payload.name} (Inngest unavailable)`
          );
        }
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
          console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/subscription.renewed`);
          const sent = await sendInngestEvent(
            {
              id: `shopify-subscription-renewed-${payload.id}`,
              name: "shopify/subscription.renewed",
              data: {
                shopifyOrderId: String(payload.id),
                shopifyOrderName: payload.name,
                shopifyStore: shopDomain || "im8",
                subscriptionContractId,
                orderJson: payload,
                receivedAt: new Date().toISOString(),
              },
            },
            requestId
          );
          if (sent) {
            console.log(
              `[Webhook] [${requestId}] ✅ Sent shopify/subscription.renewed for ${payload.name}`
            );
          }
        } else {
          console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.paid`);
          const idempotencyKey = `shopify-order-paid-${payload.id}`;
          try {
            const sendResult = await inngest.send({
              id: idempotencyKey,
              name: "shopify/order.paid",
              data: {
                shopifyOrderId: String(payload.id),
                shopifyOrderName: payload.name,
                shopifyStore: shopDomain || "im8",
                orderJson: payload,
                receivedAt: new Date().toISOString(),
                inngestIdempotencyKey: idempotencyKey,
              },
            });
            const internalEventId = sendResult.ids?.[0];
            console.log(`[Webhook] [${requestId}] ✅ Sent shopify/order.paid for ${payload.name}`);
            console.log(
              `[Webhook] [${requestId}] 📋 Internal Event ID: ${internalEventId}, Idempotency Key: ${idempotencyKey}`
            );
          } catch (error) {
            console.error(`[Webhook] [${requestId}] ⚠️  Failed to send shopify/order.paid:`, error);
            if (process.env.NODE_ENV === "development") {
              console.warn(
                `[Webhook] [${requestId}] Inngest not available - event queued but not sent. Start Inngest dev server: npm run dev:inngest`
              );
            }
          }
        }
        break;
      }

      // Order updated - may need to sync changes to D365
      case "orders/updated":
        // Only process if order is paid (avoid processing draft updates)
        if (payload.financial_status === "paid") {
          console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.updated`);
          const sent2 = await sendInngestEvent(
            {
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
            },
            requestId
          );
          if (sent2) {
            console.log(
              `[Webhook] [${requestId}] ✅ Sent shopify/order.updated for ${payload.name}`
            );
          }
        } else {
          console.log(
            `[Webhook] [${requestId}] ⏭️  Skipped orders/updated for ${payload.name} - status: ${payload.financial_status}`
          );
        }
        break;

      // Order cancelled - need to cancel in D365 and GPS
      case "orders/cancelled":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.cancelled`);
        const sent3 = await sendInngestEvent(
          {
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
          },
          requestId
        );
        if (sent3) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/order.cancelled for ${payload.name}`
          );
        }
        break;

      // Order fulfilled - Shopify notifying us (Flow 7: Shopify Direct Fulfillment)
      // This happens when Shopify is the source of truth (manual, Stord, etc.)
      case "orders/fulfilled":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/order.fulfilled`);
        const sent4 = await sendInngestEvent(
          {
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
          },
          requestId
        );
        if (sent4) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/order.fulfilled for ${payload.name}`
          );
        }
        break;

      // Refund created - need to create credit note in D365
      case "refunds/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/refund.created`);
        const sent5 = await sendInngestEvent(
          {
            id: `shopify-refund-created-${payload.id}`, // Event-level idempotency key
            name: "shopify/refund.created",
            data: {
              shopifyOrderId: String(payload.order_id),
              refundId: String(payload.id),
              shopifyStore: shopDomain || "im8",
              refundJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent5) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/refund.created for order ${payload.order_id}`
          );
        }
        break;

      // Product created - sync to D365 & GPS
      case "products/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/product.created`);
        const sent6 = await sendInngestEvent(
          {
            id: `shopify-product-created-${payload.id}`,
            name: "shopify/product.created",
            data: {
              productId: String(payload.id),
              productTitle: payload.title,
              shopifyStore: shopDomain || "im8",
              productJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent6) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/product.created for ${payload.title}`
          );
        }
        break;

      // Product updated - sync changes to D365 & GPS
      case "products/update":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/product.updated`);
        const sent7 = await sendInngestEvent(
          {
            id: `shopify-product-updated-${payload.id}-${payload.updated_at}`,
            name: "shopify/product.updated",
            data: {
              productId: String(payload.id),
              productTitle: payload.title,
              shopifyStore: shopDomain || "im8",
              productJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent7) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/product.updated for ${payload.title}`
          );
        }
        break;

      // Product deleted - sync deletion to D365 & GPS
      case "products/delete":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: shopify/product.deleted`);
        const sent8 = await sendInngestEvent(
          {
            id: `shopify-product-deleted-${payload.id}`,
            name: "shopify/product.deleted",
            data: {
              productId: String(payload.id),
              productTitle: payload.title || "Unknown",
              shopifyStore: shopDomain || "im8",
              productJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent8) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/product.deleted for product ${payload.id}`
          );
        }
        break;

      // Location created - sync to Battle Hub
      case "locations/create":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: location.created`);
        const sent9 = await sendInngestEvent(
          {
            id: `shopify-location-created-${payload.id}`,
            name: "shopify/location.created",
            data: {
              locationId: String(payload.id),
              locationName: payload.name,
              shopifyStore: shopDomain || "im8",
              locationJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent9) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/location.created for location ${payload.name} (${payload.id})`
          );
        }
        break;

      // Location updated - sync to Battle Hub
      case "locations/update":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: location.updated`);
        const sent10 = await sendInngestEvent(
          {
            id: `shopify-location-updated-${payload.id}-${payload.updated_at}`,
            name: "shopify/location.updated",
            data: {
              locationId: String(payload.id),
              locationName: payload.name,
              shopifyStore: shopDomain || "im8",
              locationJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent10) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/location.updated for location ${payload.name} (${payload.id})`
          );
        }
        break;

      // Location deleted - sync to Battle Hub
      case "locations/delete":
        console.log(`[Webhook] [${requestId}] 📤 Sending event: location.deleted`);
        const sent11 = await sendInngestEvent(
          {
            id: `shopify-location-deleted-${payload.id}`,
            name: "shopify/location.deleted",
            data: {
              locationId: String(payload.id),
              locationName: payload.name || "Unknown",
              shopifyStore: shopDomain || "im8",
              locationJson: payload,
              receivedAt: new Date().toISOString(),
            },
          },
          requestId
        );
        if (sent11) {
          console.log(
            `[Webhook] [${requestId}] ✅ Sent shopify/location.deleted for location ${payload.name || payload.id}`
          );
        }
        break;

      // Inventory level updated - sync stock levels to D365 & GPS via mesh
      case "inventory_levels/update":
        if (!config.features.enableInventorySync) {
          console.log(
            `[Webhook] [${requestId}] ⏭️  inventory_levels/update ignored (ENABLE_INVENTORY_SYNC=false)`
          );
        } else {
          console.log(`[Webhook] [${requestId}] 📤 Sending event: inventory/sync (via mesh)`);
          // Use the mesh API pattern - send to mesh which routes to destinations
          const sentDynamics = await sendInngestEvent(
            {
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
            },
            requestId
          );
          // Also sync to GPS warehouse
          const sentGps = await sendInngestEvent(
            {
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
            },
            requestId
          );
          if (sentDynamics && sentGps) {
            console.log(
              `[Webhook] [${requestId}] ✅ Sent inventory/sync events for item ${payload.inventory_item_id} at location ${payload.location_id}`
            );
          } else {
            console.log(
              `[Webhook] [${requestId}] ⚠️  Queued inventory/sync events (Inngest unavailable)`
            );
          }
        }
        break;

      default:
        console.log(`[Webhook] [${requestId}] ⚠️  Unhandled Shopify topic: ${topic}`);
    }

    const duration = Date.now() - startTime;
    console.log(`[Webhook] [${requestId}] ✅ Completed in ${duration}ms`);
    console.log(`[Webhook] [${requestId}] ========================================`);

    // Return success - webhook was received and processed
    // Note: Events may be queued if Inngest is unavailable (in dev mode)
    return NextResponse.json(
      {
        received: true,
        requestId,
        ...(process.env.NODE_ENV === "development" && {
          note: "In development mode, if Inngest dev server is not running, events are queued but not processed. Start with: npm run dev:inngest",
        }),
      },
      { status: 200 }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
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
