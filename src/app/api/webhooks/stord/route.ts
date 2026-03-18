// ============================================================================
// STORD WAREHOUSE WEBHOOK HANDLER
// ============================================================================
// Receives fulfilment notifications from STORD warehouse

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { stordWebhookSchema, validateWebhookSchema } from "@/lib/schemas/webhook-schemas";

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const authHeader = request.headers.get("authorization");

    const expectedToken = process.env.STORD_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error("[Webhook] STORD_WEBHOOK_SECRET not configured — rejecting request");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    if (authHeader !== `Bearer ${expectedToken}`) {
      console.error("[Webhook] Invalid STORD authorization");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }

    const validation = validateWebhookSchema(stordWebhookSchema, payload);
    if (!validation.success) {
      console.error(`[Webhook] Invalid STORD payload: ${validation.error}`);
      return NextResponse.json(
        { error: `Invalid payload: ${validation.error}` },
        { status: 400 }
      );
    }

    console.log(`[Webhook] Received STORD fulfilment for order: ${payload.orderNumber}`);

    // Send event to Inngest with event-level idempotency
    const stordOrderId = payload.orderId || payload.id;
    const trackingNumber = payload.trackingNumber || payload.tracking?.number || "";

    await inngest.send({
      // Event-level idempotency: unique per order + tracking number
      id: `stord-fulfilment-${stordOrderId}-${trackingNumber}`,
      name: "stord/fulfilment.received",
      data: {
        stordOrderId,
        shopifyOrderId: payload.externalOrderId || payload.shopifyOrderId || "",
        trackingNumber,
        carrierCode: payload.carrier || payload.tracking?.carrier || "",
        fulfilmentJson: payload,
        receivedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("[Webhook] Error processing STORD webhook:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
