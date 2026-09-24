// ============================================================================
// GPS WAREHOUSE WEBHOOK HANDLER
// ============================================================================
// Receives fulfilment notifications from GPS warehouse

import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/clients/gps";
import { gpsWebhookSchema, validateWebhookSchema } from "@/lib/schemas/webhook-schemas";
import { publishWebhookEvents } from "@/lib/webhooks/publish-with-inbox";

export async function POST(request: NextRequest) {
  const requestId = `gps-webhook-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const body = await request.text();
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    if (!signature || !timestamp) {
      console.error("[Webhook] Missing GPS signature or timestamp headers");
      return NextResponse.json({ error: "Missing signature headers" }, { status: 401 });
    }
    if (!verifyWebhookSignature(body, signature, timestamp)) {
      console.error("[Webhook] Invalid GPS signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }

    const validation = validateWebhookSchema(gpsWebhookSchema, payload);
    if (!validation.success) {
      console.error(`[Webhook] Invalid GPS payload: ${validation.error}`);
      return NextResponse.json({ error: `Invalid payload: ${validation.error}` }, { status: 400 });
    }

    console.log(`[Webhook] Received GPS fulfilment for order: ${payload.orderNumber}`);

    // Send event to Inngest with event-level idempotency
    const gpsOrderId = payload.orderId || payload.orderNumber;
    const trackingNumber = payload.trackingNumber;

    const result = await publishWebhookEvents({
      source: "gps",
      topic: "gps/fulfilment.received",
      payload,
      headers: Object.fromEntries(request.headers.entries()),
      events: [
        {
          // Event-level idempotency: unique per order + tracking number
          id: `gps-fulfilment-${gpsOrderId}-${trackingNumber}`,
          name: "gps/fulfilment.received",
          data: {
            gpsOrderId,
            shopifyOrderId: payload.shopifyOrderId || extractShopifyOrderId(payload),
            trackingNumber,
            carrierCode: payload.carrierCode,
            fulfilmentJson: payload,
            receivedAt: new Date().toISOString(),
          },
        },
      ],
    });

    if (!result.published) {
      console.error(
        `[Webhook] [${requestId}] Failed to publish GPS event to Inngest:`,
        result.error
      );
      return NextResponse.json(
        { received: false, error: "inngest_publication_failed", requestId },
        { status: 502 }
      );
    }

    return NextResponse.json({ received: true, requestId }, { status: 200 });
  } catch (error) {
    console.error("[Webhook] Error processing GPS webhook:", error);
    return NextResponse.json({ error: "Internal server error", requestId }, { status: 500 });
  }
}

// Extract Shopify order ID from GPS payload
function extractShopifyOrderId(payload: Record<string, unknown>): string {
  // GPS might store the Shopify order ID in different fields
  return (
    (payload.shopifyOrderId as string) ||
    (payload.externalOrderId as string) ||
    (payload.orderNumber as string) ||
    ""
  );
}

export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
