// ============================================================================
// GPS WAREHOUSE WEBHOOK HANDLER
// ============================================================================
// Receives fulfilment notifications from GPS warehouse

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { verifyWebhookSignature } from "@/lib/clients/gps";

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    // Verify webhook signature
    if (signature && timestamp && !verifyWebhookSignature(body, signature, timestamp)) {
      console.error("[Webhook] Invalid GPS signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(body);

    console.log(`[Webhook] Received GPS fulfilment for order: ${payload.orderNumber}`);

    // Send event to Inngest
    await inngest.send({
      name: "gps/fulfilment.received",
      data: {
        gpsOrderId: payload.orderId || payload.orderNumber,
        shopifyOrderId: payload.shopifyOrderId || extractShopifyOrderId(payload),
        trackingNumber: payload.trackingNumber,
        carrierCode: payload.carrierCode,
        fulfilmentJson: payload,
        receivedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("[Webhook] Error processing GPS webhook:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
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
